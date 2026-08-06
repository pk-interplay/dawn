import { NextResponse } from "next/server";
import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { ingestGmailNetwork } from "../../../../src/lib/network-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Nexus v0.2 build step 2 (SPEC.md §7 step 2). Adapted from nexus's
 * onboarding/sync routes — no profile synthesis (step 3's summarize_entity)
 * and no company enrichment (dropped per SPEC §0) here, just the Gmail/
 * Calendar ingest into the claims graph.
 *
 * Uses the service-role client (src/lib/supabase.ts), not app/lib/db.ts's
 * publishable-key client: this route runs as whichever teammate is the
 * ingest source (src/auth.ts's own domain-restricted NextAuth session gates
 * who can reach it), not as an anonymous caller RLS needs to constrain.
 */
export async function POST() {
  const session = await auth();
  if (!session?.accessToken || !session.user?.email) {
    return NextResponse.json({ error: "Not signed in with Google" }, { status: 401 });
  }

  try {
    const summary = await ingestGmailNetwork(supabase, session.accessToken, session.user.email);
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ingest failed" },
      { status: 500 },
    );
  }
}
