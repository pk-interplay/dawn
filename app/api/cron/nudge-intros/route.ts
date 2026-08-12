import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import { nudgeIntroduction } from "../../../../src/lib/intro-flow";
import { readNetworkSettings } from "../../../../src/lib/network-settings";

export const runtime = "nodejs";
// Each nudge is a model call plus a send, so a batch is slow in the same way
// run-matches is. Same ceiling for the same reason.
export const maxDuration = 300;

// Deliberately smaller than run-matches' scan limit. A backlog is not urgent — the
// job runs every few hours and a row that waits one extra cycle is a follow-up
// arriving at +3d4h instead of +3d, which nobody can perceive. Capping the batch
// keeps one slow run from timing out mid-way and leaving half the rows re-armed.
const DEFAULT_BATCH = 25;

/**
 * Follow up on introductions nobody has answered, and retire the ones whose
 * follow-up allowance is spent.
 *
 * The route is a thin selector: it finds rows whose `next_action_at` has come due and
 * hands each to `nudgeIntroduction`, which owns every decision about who to chase,
 * whether to chase at all, and what to do when the allowance runs out. Keeping the
 * policy there rather than here means the sweep cannot disagree with the state
 * machine about whether a row is nudgeable.
 *
 * Gated on the same network master switch as run-matches. A switch that stops new
 * introductions but lets follow-ups keep flowing would not be an off switch.
 */
async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit")) || DEFAULT_BATCH;
  // Target one introduction, for testing a single follow-up without waiting for its
  // due time — the same escape hatch run-matches offers via ?person_id=. It bypasses
  // the due-time filter only; `nudgeIntroduction` still refuses a row that is not
  // actually waiting on someone.
  const onlyIntroId = url.searchParams.get("introduction_id");

  try {
    const settings = await readNetworkSettings(db);
    if (!settings.enabled && !onlyIntroId) {
      return NextResponse.json({
        ok: true,
        nudged: 0,
        expired: 0,
        note: "Network is switched off; no follow-ups sent.",
      });
    }

    let query = db
      .from("introductions")
      .select("id")
      .not("next_action_at", "is", null)
      .order("next_action_at", { ascending: true })
      .limit(limit);
    query = onlyIntroId
      ? query.eq("id", onlyIntroId)
      : query.lte("next_action_at", new Date().toISOString());

    const { data: due, error } = await query;
    if (error) throw new Error(error.message);

    // Sequential, not Promise.all. These are model calls and sends against a shared
    // inbox; a burst of 25 concurrent AgentMail sends is both a rate-limit risk and a
    // deliverability one, and there is no deadline pressure to justify it.
    const results = [];
    for (const row of due ?? []) {
      results.push(await nudgeIntroduction(db, row.id));
    }

    return NextResponse.json({
      ok: true,
      due: due?.length ?? 0,
      nudged: results.filter((r) => r.action === "nudged").length,
      expired: results.filter((r) => r.action === "expired").length,
      skipped: results.filter((r) => r.action === "skipped").length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "nudge-intros failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
