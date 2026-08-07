import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { ensureViewerEntity } from "../../../../src/lib/entity-identity";
import { ingestGmailNetwork } from "../../../../src/lib/network-ingest";
import {
  synthesizeProfile,
  describeEvidence,
  SYNTHESIS_MODEL,
} from "../../../../src/lib/synthesize-profile";

/**
 * Onboarding step 1: build the graph, then draft a profile.
 *
 * Service-role client, following the precedent set by /api/ingest/gmail: this route
 * runs as whichever user is signed in and writes on their behalf, and the NextAuth
 * session is what gates who can reach it — not something RLS should be constraining
 * as an anonymous caller.
 *
 * The draft is written to `profile_drafts`, NOT to claims. Until the user presses
 * Confirm, nothing about them is visible to anyone else in the network. Staging it
 * server-side rather than holding it in the client means a refresh, a closed tab, or a
 * slow connection does not lose several seconds of model work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Gmail ingest pages through six months of metadata, then synthesis is a Sonnet call.
// nexus used 60s for the same shape of work and occasionally grazed it.
export const maxDuration = 300;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!session.accessToken) {
    // The refresh path in src/auth.ts clears accessToken when it cannot renew, which
    // is a real state, not a bug: the Google grant was revoked or expired past repair.
    return NextResponse.json(
      { error: "Your Google access expired. Sign in again to reconnect Gmail." },
      { status: 401 },
    );
  }

  const viewer = await ensureViewerEntity(supabase, session);

  // Ingest first and separately. It is the part that must succeed — it is the graph —
  // and it is the part with no model call in it.
  let ingest;
  try {
    ingest = await ingestGmailNetwork(supabase, session.accessToken, viewer.email);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gmail ingest failed";
    console.error("[onboarding] ingest failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Synthesis gets its own try/catch, and this is deliberate. nexus's equivalent
  // route did not have one, so a synthesis failure returned 500 and the user saw
  // "Something went wrong" even though their entire network had just been ingested
  // successfully. The graph is the valuable part; a missing draft is recoverable by
  // pressing Regenerate.
  let synthesis;
  try {
    synthesis = await synthesizeProfile({
      accessToken: session.accessToken,
      email: viewer.email,
      name: session.user.name ?? null,
    });
  } catch (err) {
    console.error("[onboarding] synthesis failed:", err);
    return NextResponse.json({
      entityId: viewer.entityId,
      ingest,
      draft: null,
      generated: false,
      reason: "error" as const,
    });
  }

  if (synthesis.draft) {
    const { error } = await supabase.from("profile_drafts").upsert(
      {
        entity_id: viewer.entityId,
        draft: synthesis.draft,
        model: SYNTHESIS_MODEL,
        created_at: new Date().toISOString(),
      },
      { onConflict: "entity_id" },
    );
    if (error) {
      // The draft exists but could not be staged. Return it anyway rather than
      // throwing away a model call — Confirm will re-synthesise if it finds no row.
      console.error("[onboarding] failed to stage draft:", error.message);
    }
  }

  return NextResponse.json({
    entityId: viewer.entityId,
    ingest,
    draft: synthesis.draft,
    generated: synthesis.generated,
    reason: synthesis.reason,
    evidenceNote: describeEvidence(synthesis.evidence),
  });
}
