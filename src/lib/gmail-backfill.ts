// The Gmail backfill — what drains the history the shallow onboarding skipped.
//
// Onboarding reads only the last SHALLOW_WINDOW_DAYS interactively and seeds
// gmail_sync_state with a backfill window: [backfill_until, backfill_before).
// Each pass here claims the mailbox, lists the window newest-first, fetches
// what one paced minute of quota affords, folds it into the graph, and walks
// backfill_before back to the oldest message it landed. When a listing drains
// (nothing older left), the cursor is cleared and last_full_ingest_at is set —
// that column's meaning is "the full lookback window is in the graph".
//
// It takes the SAME claim row as the hourly sync and onboarding, so no two
// readers ever spend one user's per-minute quota concurrently. It never bumps
// last_synced_at (that cursor belongs to the forward sync) and never reads the
// calendar (onboarding already covers the full calendar window — it is cheap).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchHeaders,
  listMessageIds,
  RunBudget,
  type Deadline,
  type GmailHeaderSet,
} from "./gmail-ingest";
import { claimSyncRow, NoAccountRowError, releaseSyncRow } from "./gmail-sync";
import { writeActivityToGraph } from "./network-ingest";
import { getGoogleAccessToken } from "./google-account";

/**
 * RECEIVED_EXCLUSIONS minus `-in:sent`: the backfill lists sent and received in
 * ONE query. The sent-priority split exists so profile synthesis gets the user's
 * own mail first — but the backfill never feeds synthesis, and a single
 * newest-first stream is what makes one moving cursor sound (two streams that
 * truncate at different depths have no shared "everything newer is done" point).
 */
const BACKFILL_EXCLUSIONS =
  "-in:chats -in:draft -category:promotions -category:social -category:forums";

/**
 * One pass's quota budget: ~2,400 messages, one paced minute at the
 * QUOTA_BUDGET_UNITS rate, leaving 3k/min of the user's 15k ceiling free so an
 * interactive request landing mid-pass is not starved.
 */
const BACKFILL_BUDGET_UNITS = 12_000;

/** When a pass lands zero usable timestamps, step the cursor back by brute
 *  force so the backfill always terminates. */
const FORCED_STEP_DAYS = 7;

export interface BackfillOutcome {
  googleSub: string;
  status: "ok" | "drained" | "skipped_running" | "nothing_to_do" | "revoked" | "error";
  messages: number;
  edges: number;
  /** Where the next pass resumes (ISO). Absent when drained / not applicable. */
  before?: string;
  error?: string;
}

/**
 * One backfill pass for one account. Never throws for ordinary failures — the
 * cron sums BackfillOutcomes and gmail_sync_state carries the durable record.
 */
export async function backfillGmailForAccount(
  client: SupabaseClient,
  googleSub: string,
  opts: { deadline: Deadline; budget?: RunBudget },
): Promise<BackfillOutcome> {
  const base: BackfillOutcome = { googleSub, status: "ok", messages: 0, edges: 0 };

  let claimed: boolean;
  try {
    claimed = await claimSyncRow(client, googleSub);
  } catch (err) {
    if (err instanceof NoAccountRowError) {
      return { ...base, status: "error", error: "no google_accounts row (user must sign in once)" };
    }
    return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  if (!claimed) return { ...base, status: "skipped_running" };

  try {
    const { data: account } = await client
      .from("google_accounts")
      .select("email")
      .eq("google_sub", googleSub)
      .maybeSingle();
    const { data: state } = await client
      .from("gmail_sync_state")
      .select("backfill_before, backfill_until")
      .eq("google_sub", googleSub)
      .maybeSingle();

    const email = (account?.email as string | undefined)?.toLowerCase();
    if (!email) {
      await releaseSyncRow(client, googleSub, { ok: false, error: "account row missing email" });
      return { ...base, status: "error", error: "account row missing email" };
    }
    const beforeMs = state?.backfill_before ? Date.parse(state.backfill_before as string) : NaN;
    const untilMs = state?.backfill_until ? Date.parse(state.backfill_until as string) : NaN;
    if (!Number.isFinite(beforeMs) || !Number.isFinite(untilMs)) {
      // Cursor already cleared (or this account predates the backfill) — the
      // route's selector filters on it, so this is only a race with another pass.
      await releaseSyncRow(client, googleSub, { ok: true, skipLastSynced: true });
      return { ...base, status: "nothing_to_do" };
    }

    const token = await getGoogleAccessToken(client, googleSub);
    if (!token.ok) {
      await releaseSyncRow(client, googleSub, { ok: false, error: `token: ${token.reason}` });
      return { ...base, status: token.reason === "revoked" ? "revoked" : "error", error: token.detail };
    }

    const budget = opts.budget ?? new RunBudget(BACKFILL_BUDGET_UNITS);
    const quotaKey = email;
    const after = Math.floor(untilMs / 1000);
    const before = Math.floor(beforeMs / 1000);
    // Every id listed should also be fetchable within this pass's budget:
    // list and get both cost 5 units, so leave the get's share when capping.
    const cap = Math.floor(budget.remaining() / 10);

    const { ids, truncated } = await listMessageIds(
      token.accessToken,
      budget,
      `${BACKFILL_EXCLUSIONS} after:${after} before:${before}`,
      cap,
      "backfill",
      opts.deadline,
      quotaKey,
    );

    if (ids.length === 0) {
      // Nothing left in the window: the backfill is finished for this account.
      await releaseSyncRow(client, googleSub, {
        ok: true,
        fullIngest: true,
        backfillBefore: null,
        skipLastSynced: true,
      });
      console.log(`[gmail-backfill] ${email}: window drained, full ingest complete`);
      return { ...base, status: "drained" };
    }

    const headers = await fetchHeaders(
      token.accessToken,
      budget,
      ids,
      "backfill",
      undefined,
      opts.deadline,
      undefined,
      quotaKey,
    );
    // No isNetworkSignal filter needed: the q= above already excludes, the same
    // way the onboarding ingest's query does.

    const summary = await writeActivityToGraph(
      client,
      email,
      { headers, events: [] },
      { mode: "incremental", deadline: opts.deadline },
    );
    if (summary.truncated) {
      // Cursor must NOT advance past work that wasn't written — leave it so the
      // next pass replays this slice (idempotent upserts absorb the overlap).
      await releaseSyncRow(client, googleSub, { ok: false, error: "write truncated by deadline" });
      return {
        ...base,
        status: "error",
        messages: headers.length,
        edges: summary.edgesWritten,
        error: "write truncated by deadline",
      };
    }

    const drained = truncated === null && headers.length === ids.length;
    if (drained) {
      await releaseSyncRow(client, googleSub, {
        ok: true,
        fullIngest: true,
        backfillBefore: null,
        skipLastSynced: true,
      });
      console.log(
        `[gmail-backfill] ${email}: ${headers.length} message(s), ${summary.edgesWritten} edge(s) — window drained, full ingest complete`,
      );
      return { ...base, status: "drained", messages: headers.length, edges: summary.edgesWritten };
    }

    const nextBefore = nextCursor(headers, beforeMs);
    await releaseSyncRow(client, googleSub, {
      ok: true,
      backfillBefore: nextBefore,
      skipLastSynced: true,
    });
    console.log(
      `[gmail-backfill] ${email}: ${headers.length} message(s), ${summary.edgesWritten} edge(s), cursor → ${nextBefore}`,
    );
    return {
      ...base,
      status: "ok",
      messages: headers.length,
      edges: summary.edgesWritten,
      before: nextBefore,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gmail-backfill] ${googleSub} failed:`, message);
    await releaseSyncRow(client, googleSub, { ok: false, error: message });
    return { ...base, status: "error", error: message };
  }
}

/**
 * Where the next pass's `before:` goes: one second past the oldest message this
 * pass landed. Gmail lists newest-first, so everything newer than that is done;
 * the +1s means a same-second sibling is refetched rather than skipped — one
 * possibly re-counted message per pass, bounded by the edge write's min(1, …).
 *
 * internalDateMs is the timestamp Gmail's own before:/after: compare against;
 * the RFC-2822 Date header is the sender-supplied fallback. If neither yields a
 * usable value, or the cursor would not move (all timestamps lying newer than
 * the window), force a FORCED_STEP_DAYS step so the backfill always terminates.
 */
export function nextCursor(headers: GmailHeaderSet[], currentBeforeMs: number): string {
  let oldest = Infinity;
  for (const h of headers) {
    const ms = h.internalDateMs ?? (h.date ? Date.parse(h.date) : NaN);
    if (Number.isFinite(ms) && ms < oldest) oldest = ms;
  }
  const candidate = oldest === Infinity ? NaN : oldest + 1_000;
  const next =
    Number.isFinite(candidate) && candidate < currentBeforeMs
      ? candidate
      : currentBeforeMs - FORCED_STEP_DAYS * 86_400_000;
  return new Date(next).toISOString();
}
