import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../../src/lib/entity-identity";
import {
  synthesizeProfile,
  describeEvidence,
  SYNTHESIS_MODEL,
} from "../../../../src/lib/synthesize-profile";

/**
 * Regenerate the staged draft — the "Regenerate" button on the confirm screen.
 *
 * Separate from the ingest route because re-running six months of Gmail ingest to
 * reword a headline would be absurd: the graph has not changed, only the draft is
 * being rerolled. Synthesis re-reads Gmail metadata (it needs the subject lines) but
 * writes no edges and no claims.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!session.accessToken) {
    return NextResponse.json(
      { error: "Your Google access expired. Sign in again to reconnect Gmail." },
      { status: 401 },
    );
  }

  const viewer = await resolveViewerEntity(supabase, session);
  if (!viewer) {
    return NextResponse.json(
      { error: "No graph yet — run the Gmail sync first." },
      { status: 409 },
    );
  }

  // Optional user steer from the "Add guidance" field on the review screen. Cap the
  // length so a pasted essay can't blow out the prompt; the model only needs a nudge.
  let guidance: string | null = null;
  try {
    const body = (await req.json()) as { guidance?: unknown };
    if (typeof body.guidance === "string" && body.guidance.trim()) {
      guidance = body.guidance.trim().slice(0, 500);
    }
  } catch {
    // No body / not JSON — regenerate with no guidance, same as before.
  }

  let synthesis;
  try {
    synthesis = await synthesizeProfile({
      accessToken: session.accessToken,
      email: viewer.email,
      name: session.user.name ?? null,
      guidance,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Synthesis failed";
    console.error("[onboarding] regenerate failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
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
    if (error) console.error("[onboarding] failed to stage draft:", error.message);
  }

  return NextResponse.json({
    draft: synthesis.draft,
    generated: synthesis.generated,
    reason: synthesis.reason,
    evidenceNote: describeEvidence(synthesis.evidence),
  });
}
