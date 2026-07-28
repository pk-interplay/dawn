import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";

export const runtime = "nodejs";

// Recompute relationship proximity: time-decay every relationship's strength and
// let stale ones fall to 'dormant'. All the work lives in the SQL function so
// this route is a thin, idempotent trigger for the daily cron.
async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { data, error } = await db.rpc("recompute_relationship_strength", { half_life_days: 30 });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, relationships_updated: data ?? 0 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "decay-proximity failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
