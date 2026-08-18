// The incremental Gmail sync — what stops the graph being a one-time snapshot.
//
// One pass for one account: claim the account's gmail_sync_state row, get a
// fresh access token from the server-side store, list what changed since the
// stored historyId (users.history.list), fetch those headers metadata-only,
// re-read a bounded calendar window, and fold it all into the graph through the
// same idempotent write path onboarding uses (writeActivityToGraph, mode
// "incremental"). The cursor only advances after a successful write, so a run
// killed mid-flight re-fetches and re-upserts — never loses.
//
// The claim row is also the mailbox mutex: onboarding ingest takes the same
// claim, so a cron pass and an onboarding run can no longer read one mailbox
// concurrently and 429 each other's quota.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchGmailHistoryId,
  fetchHeaders,
  fetchRecentCalendarEvents,
  isNetworkSignal,
  listHistoryMessageIds,
  listMessageIds,
  RECEIVED_EXCLUSIONS,
  RunBudget,
  type Deadline,
  type GmailActivity,
} from "./gmail-ingest";
import { writeActivityToGraph } from "./network-ingest";
import { getGoogleAccessToken } from "./google-account";

/** A claim older than this is a run the platform killed; take it over. Far
 *  longer than any real pass (the cron slices ≤45s per account; onboarding's
 *  whole budget is 270s). */
const CLAIM_STALE_MINUTES = 15;

/** Per-account quota budget for one incremental pass: ~500 messages' worth.
 *  Deliberately a small fraction of a full ingest's 15,000 so a background pass
 *  can never starve an interactive onboarding of the user's per-minute quota. */
const SYNC_BUDGET_UNITS = 2_500;

/** How far behind last_synced_at the stale-history fallback re-lists. Gmail
 *  keeps ~a week of history, so a 404 means we are at least that far behind. */
const FALLBACK_LOOKBACK_DAYS = 7;
const FALLBACK_MESSAGE_CAP = 500;

/** Calendar window for an incremental pass: recent past + upcoming meetings
 *  (which the initial ingest misses entirely). */
const CALENDAR_PAST_DAYS = 30;
const CALENDAR_FUTURE_DAYS = 60;

export interface SyncOutcome {
  googleSub: string;
  status: "ok" | "skipped_running" | "no_baseline" | "revoked" | "stale_fallback" | "error";
  messages: number;
  edges: number;
  historyId?: string;
  error?: string;
}

/**
 * Take the mailbox claim for one account. True = this caller owns the mailbox
 * until it releases; false = another run genuinely holds it. A row whose claim
 * is stale (SIGKILLed run) is taken over. Creates the row if none exists.
 */
export async function claimSyncRow(client: SupabaseClient, googleSub: string): Promise<boolean> {
  const now = new Date().toISOString();
  const ins = await client
    .from("gmail_sync_state")
    .insert({ google_sub: googleSub, status: "running", started_at: now, updated_at: now });
  if (!ins.error) return true;
  if (ins.error.code === "23503") {
    // No google_accounts row (a session that predates the credential store).
    // There is nothing to sync and nothing to guard; the caller proceeds unclaimed.
    throw new NoAccountRowError(googleSub);
  }
  if (ins.error.code !== "23505") {
    throw new Error(`gmail_sync_state claim insert failed: ${ins.error.message}`);
  }

  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await client
    .from("gmail_sync_state")
    .update({ status: "running", started_at: now, updated_at: now })
    .eq("google_sub", googleSub)
    .or(`status.neq.running,started_at.lt.${staleCutoff}`)
    .select("google_sub");
  if (error) throw new Error(`gmail_sync_state claim update failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export class NoAccountRowError extends Error {
  constructor(googleSub: string) {
    super(`no google_accounts row for ${googleSub}`);
    this.name = "NoAccountRowError";
  }
}

export async function releaseSyncRow(
  client: SupabaseClient,
  googleSub: string,
  outcome:
    | {
        ok: true;
        historyId?: string;
        fullIngest?: boolean;
        /** Backfill cursor: an ISO timestamp advances it, null clears it (window
         *  drained). Undefined leaves it alone. */
        backfillBefore?: string | null;
        /** The fixed far edge of the backfill window, seeded once at onboarding. */
        backfillUntil?: string;
        /** Backfill passes must not bump last_synced_at — it orders the hourly
         *  sync's fan-out and anchors its stale-history fallback window, and a
         *  backfill of months-old mail is not a sync. */
        skipLastSynced?: boolean;
      }
    | { ok: false; error: string },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = outcome.ok
    ? {
        status: "idle",
        started_at: null,
        failure_count: 0,
        last_error: null,
        updated_at: now,
        ...(outcome.skipLastSynced ? {} : { last_synced_at: now }),
        ...(outcome.historyId ? { history_id: outcome.historyId } : {}),
        ...(outcome.fullIngest ? { last_full_ingest_at: now } : {}),
        ...(outcome.backfillBefore !== undefined ? { backfill_before: outcome.backfillBefore } : {}),
        ...(outcome.backfillUntil ? { backfill_until: outcome.backfillUntil } : {}),
      }
    : {
        // 'error' is still claimable by the next pass; failure_count is bumped
        // via a read-modify-write below (PostgREST has no increment).
        status: "error",
        started_at: null,
        last_error: outcome.error.slice(0, 500),
        updated_at: now,
      };
  const { error } = await client.from("gmail_sync_state").update(patch).eq("google_sub", googleSub);
  if (error) console.error(`[gmail-sync] could not release claim for ${googleSub}: ${error.message}`);
  if (!outcome.ok) {
    const { data } = await client
      .from("gmail_sync_state")
      .select("failure_count")
      .eq("google_sub", googleSub)
      .maybeSingle();
    await client
      .from("gmail_sync_state")
      .update({ failure_count: ((data?.failure_count as number) ?? 0) + 1 })
      .eq("google_sub", googleSub);
  }
}

/**
 * One incremental pass for one account. Never throws for ordinary failures —
 * the cron sums SyncOutcomes and gmail_sync_state carries the durable record.
 */
export async function syncGmailForAccount(
  client: SupabaseClient,
  googleSub: string,
  opts: { deadline: Deadline; budget?: RunBudget } ,
): Promise<SyncOutcome> {
  const base: SyncOutcome = { googleSub, status: "ok", messages: 0, edges: 0 };

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
    // ---- account + cursor --------------------------------------------------
    const { data: account } = await client
      .from("google_accounts")
      .select("email")
      .eq("google_sub", googleSub)
      .maybeSingle();
    const { data: state } = await client
      .from("gmail_sync_state")
      .select("history_id, last_synced_at")
      .eq("google_sub", googleSub)
      .maybeSingle();

    const email = (account?.email as string | undefined)?.toLowerCase();
    if (!email) {
      await releaseSyncRow(client, googleSub, { ok: false, error: "account row missing email" });
      return { ...base, status: "error", error: "account row missing email" };
    }
    if (!state?.history_id) {
      // No baseline = onboarding never completed for this account. The full
      // ingest is the consent-carrying first read; the background sync must not
      // be the thing that performs it.
      await releaseSyncRow(client, googleSub, { ok: false, error: "no history baseline (onboarding incomplete)" });
      return { ...base, status: "no_baseline" };
    }

    const token = await getGoogleAccessToken(client, googleSub);
    if (!token.ok) {
      await releaseSyncRow(client, googleSub, { ok: false, error: `token: ${token.reason}` });
      return { ...base, status: token.reason === "revoked" ? "revoked" : "error", error: token.detail };
    }

    const budget = opts.budget ?? new RunBudget(SYNC_BUDGET_UNITS);
    const quotaKey = email;

    // ---- what changed ------------------------------------------------------
    let ids: string[];
    let newHistoryId: string;
    let usedFallback = false;

    const delta = await listHistoryMessageIds(
      token.accessToken,
      budget,
      String(state.history_id),
      opts.deadline,
      quotaKey,
    );
    if (delta.stale) {
      // Gmail dropped our baseline (~a week of retention). Bounded re-list from
      // just before the last successful sync; idempotent upserts absorb overlap.
      usedFallback = true;
      const lastSynced = state.last_synced_at ? Date.parse(state.last_synced_at as string) : Date.now();
      const after = Math.floor((lastSynced - FALLBACK_LOOKBACK_DAYS * 86_400_000) / 1000);
      const { ids: sent } = await listMessageIds(
        token.accessToken, budget, `in:sent after:${after}`,
        Math.floor(FALLBACK_MESSAGE_CAP / 2), "sync-fallback-sent", opts.deadline, quotaKey,
      );
      const { ids: received } = await listMessageIds(
        token.accessToken, budget, `${RECEIVED_EXCLUSIONS} after:${after}`,
        FALLBACK_MESSAGE_CAP - sent.length, "sync-fallback-received", opts.deadline, quotaKey,
      );
      ids = [...new Set([...sent, ...received])];
      newHistoryId = await fetchGmailHistoryId(token.accessToken, quotaKey);
    } else {
      ids = delta.ids;
      newHistoryId = delta.historyId;
    }

    // ---- fetch + write -----------------------------------------------------
    const headers = ids.length
      ? (
          await fetchHeaders(token.accessToken, budget, ids, "sync", undefined, opts.deadline, undefined, quotaKey)
        ).filter(isNetworkSignal)
      : [];

    const now = Date.now();
    const events = await fetchRecentCalendarEvents(token.accessToken, opts.deadline, quotaKey, {
      timeMin: new Date(Math.min(
        state.last_synced_at ? Date.parse(state.last_synced_at as string) : now,
        now - CALENDAR_PAST_DAYS * 86_400_000,
      )),
      timeMax: new Date(now + CALENDAR_FUTURE_DAYS * 86_400_000),
    });

    let edges = 0;
    if (headers.length || events.length) {
      const activity: GmailActivity = { headers, events };
      const summary = await writeActivityToGraph(client, email, activity, {
        mode: "incremental",
        deadline: opts.deadline,
      });
      edges = summary.edgesWritten;
      if (summary.truncated) {
        // Cursor must NOT advance past work that wasn't written — leave the old
        // baseline so the next pass replays this delta.
        await releaseSyncRow(client, googleSub, { ok: false, error: "write truncated by deadline" });
        return { ...base, status: "error", messages: headers.length, edges, error: "write truncated by deadline" };
      }
    }

    await releaseSyncRow(client, googleSub, { ok: true, historyId: newHistoryId });
    console.log(
      `[gmail-sync] ${email}: ${headers.length} message(s), ${events.length} event(s), ${edges} edge(s)` +
        (usedFallback ? " (stale history — bounded re-list)" : ""),
    );
    return {
      ...base,
      status: usedFallback ? "stale_fallback" : "ok",
      messages: headers.length,
      edges,
      historyId: newHistoryId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gmail-sync] ${googleSub} failed:`, message);
    await releaseSyncRow(client, googleSub, { ok: false, error: message });
    return { ...base, status: "error", error: message };
  }
}
