import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";

export const runtime = "nodejs";

const TTL_DAYS = 7; // introductions with no resolution after this are expired
const OPEN_STATES = ["proposed", "a_invited", "b_invited", "a_opted_in", "b_opted_in", "both_opted_in"];

// Sweep introductions that stalled (nobody opted in / never scheduled) so they
// stop counting as live and members can be re-matched later.
async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const since = new Date(Date.now() - TTL_DAYS * 86_400_000).toISOString();
    const { data, error } = await db
      .from("introductions")
      .update({ state: "expired", updated_at: new Date().toISOString() })
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
