import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import { syncGmailForAccount, type SyncOutcome } from "../../../../src/lib/gmail-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each account is a paced Gmail read; the fan-out below slices the budget.
export const maxDuration = 300;

/** maxDuration − 30s of headroom — the onboarding route's pattern. */
const RUN_BUDGET_MS = 270_000;
/** Accounts per hourly run. Oldest-synced-first means everyone converges to the
 *  cadence even when a run only finishes some of them. */
const PER_RUN_CAP = 8;
/** One account may not eat the whole run. */
const PER_ACCOUNT_MS = 45_000;
/** Don't start an account with less than this left — a claim taken and then
 *  abandoned at the deadline costs the next run a stale-claim wait. */
const MIN_SLICE_MS = 30_000;

/**
 * The hourly incremental Gmail sync (pg_cron `dawn-sync-gmail`, migration 0044).
 *
 * A thin fan-out: pick the accounts whose sync is oldest, hand each to
 * syncGmailForAccount sequentially (Gmail quota is per-user; parallelism buys
 * little and risks the deadline), stop when the run budget is nearly spent.
 * pg_net drops this response by design (5s timeout vs a long route), so the
 * durable record is gmail_sync_state itself — last_synced_at, failure_count,
 * last_error — plus the per-account console lines.
 *
 * Test escape hatches, matching run-matches' style:
 *   ?google_sub=…  target one account, bypassing the cap and the candidate order
 *   ?limit=N       override PER_RUN_CAP
 */
async function run(req: Request) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_BUDGET_MS;
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const onlySub = url.searchParams.get("google_sub");
  const limit = Number(url.searchParams.get("limit")) || PER_RUN_CAP;

  try {
    let subs: string[];
    if (onlySub) {
      subs = [onlySub];
    } else {
      // Only accounts with a history baseline — no baseline means onboarding
      // never completed, and the background sync must not be the first read.
      const { data, error } = await db
        .from("gmail_sync_state")
        .select("google_sub")
        .not("history_id", "is", null)
        .order("last_synced_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      subs = (data ?? []).map((row) => row.google_sub as string);
    }

    const results: SyncOutcome[] = [];
    for (const sub of subs) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_SLICE_MS) {
        console.info(`[sync-gmail] stopping with ${results.length}/${subs.length} done; out of time`);
        break;
      }
      results.push(
        await syncGmailForAccount(db, sub, {
          deadline: Date.now() + Math.min(remaining, PER_ACCOUNT_MS),
        }),
      );
    }

    return NextResponse.json({
      ok: true,
      candidates: subs.length,
      synced: results.filter((r) => r.status === "ok" || r.status === "stale_fallback").length,
      skipped: results.filter((r) => r.status === "skipped_running" || r.status === "no_baseline").length,
      failed: results.filter((r) => r.status === "error" || r.status === "revoked").length,
      results,
    });
  } catch (err) {
    console.error("[sync-gmail] run failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sync-gmail failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
