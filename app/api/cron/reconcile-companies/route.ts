import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import { reconcileCompanies } from "../../../../src/lib/reconcile-companies";

export const runtime = "nodejs";

// Promote work-email domains that cross the people threshold to organization
// entities and enrich them via Exa. All the work lives in reconcileCompanies();
// this route is a thin, idempotent trigger for the daily cron (and manual runs).
async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await reconcileCompanies(db);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reconcile-companies failed" },
      { status: 500 },
    );
  }
}

export const POST = run;
export const GET = run;
