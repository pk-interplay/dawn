import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import { backfillGmailForAccount, type BackfillOutcome } from "../../../../src/lib/gmail-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each account is up to a full paced quota-minute of Gmail reads plus the write.
export const maxDuration = 300;

/** maxDuration − 30s of headroom — the onboarding route's pattern. */
const RUN_BUDGET_MS = 270_000;
/** Accounts per hourly run. A full backfill pass is ~60s of paced read plus the
 *  graph write, so three fit the budget with room to spare; least-recently-
 *  attempted-first means everyone's cursor keeps moving across runs. */
const PER_RUN_CAP = 3;
/** One account may not eat the whole run — but a backfill slice is most of a
 *  paced quota-minute, so it gets far more than a sync slice's 45s. */
const PER_ACCOUNT_MS = 120_000;
/** Don't start an account with less than this left: ~45s still moves the cursor
 *  meaningfully (~7k units of paced read), anything less mostly pays claim
 *  overhead. */
const MIN_SLICE_MS = 45_000;

/**
 * The hourly Gmail backfill (pg_cron `dawn-backfill-gmail`, migration 0045).
 *
 * A thin fan-out over accounts whose backfill window still has mail in it
 * (`backfill_before is not null`), sequential for the same reason sync-gmail is:
 * Gmail quota is per-user, so parallelism buys little and risks the deadline.
 * pg_net drops this response by design, so the durable record is
 * gmail_sync_state itself — backfill_before, last_full_ingest_at, last_error —
 * plus the per-account console lines.
 *
 * Test escape hatches, matching sync-gmail's style:
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
      const { data, error } = await db
        .from("gmail_sync_state")
        .select("google_sub")
        .not("backfill_before", "is", null)
        .order("updated_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      subs = (data ?? []).map((row) => row.google_sub as string);
    }

    const results: BackfillOutcome[] = [];
    for (const sub of subs) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_SLICE_MS) {
        console.info(
          `[backfill-gmail] stopping with ${results.length}/${subs.length} done; out of time`,
        );
        break;
      }
      results.push(
        await backfillGmailForAccount(db, sub, {
          deadline: Date.now() + Math.min(remaining, PER_ACCOUNT_MS),
        }),
      );
    }

    return NextResponse.json({
      ok: true,
      candidates: subs.length,
      advanced: results.filter((r) => r.status === "ok" || r.status === "drained").length,
      drained: results.filter((r) => r.status === "drained").length,
      skipped: results.filter((r) => r.status === "skipped_running" || r.status === "nothing_to_do")
        .length,
      failed: results.filter((r) => r.status === "error" || r.status === "revoked").length,
      results,
    });
  } catch (err) {
    console.error("[backfill-gmail] run failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "backfill-gmail failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
