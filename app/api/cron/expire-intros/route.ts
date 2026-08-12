import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";

export const runtime = "nodejs";

// Must sit clear of the whole nudge sequence, which runs to roughly day 11
// (first follow-up at +3d, second at +7d, retired at +11d — see NUDGE_* in
// intro-flow). At the old seven days this sweep expired rows out from under their
// own second follow-up, so the nudge allowance the schema tracks would never have
// been spent.
const TTL_DAYS = 14;
const OPEN_STATES = ["proposed", "a_invited", "b_invited", "a_opted_in", "b_opted_in", "both_opted_in"];

// Sweep introductions that stalled so they stop counting as live and members can be
// re-matched later.
//
// This is now a BACKSTOP, not the primary retirement path: /api/cron/nudge-intros
// follows up and then expires rows on its own clock. What is left for this route is
// the set that clock cannot reach — rows whose `next_action_at` was never armed
// (opened before migration 0036, or left null by a partial write) and rows stuck in
// `both_opted_in`, which no longer has a transition out of it.
async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const since = new Date(Date.now() - TTL_DAYS * 86_400_000).toISOString();
    const { data, error } = await db
      .from("introductions")
      .update({
        state: "expired",
        awaiting: null,
        next_action_at: null,
        updated_at: new Date().toISOString(),
      })
      .lt("created_at", since)
      .in("state", OPEN_STATES)
      .select("id");
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, expired: data?.length ?? 0 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "expire-intros failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
