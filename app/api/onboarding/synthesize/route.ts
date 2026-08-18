import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../../src/lib/entity-identity";
import { getGoogleAccessToken } from "../../../../src/lib/google-account";
import { publicGoogleErrorMessage } from "../../../../src/lib/gmail-ingest";
import {
  synthesizeProfile,
  describeEvidence,
  DistilledEvidenceSchema,
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
  // Server-side token first; cookie as fallback for pre-store sessions.
  const tokenResult = await getGoogleAccessToken(supabase, session.user.id);
  const accessToken = tokenResult.ok ? tokenResult.accessToken : session.accessToken;
  if (!accessToken) {
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

  // The evidence stashed at ingest time (profile_drafts.evidence). With it,
  // regenerating is a single model call — the old path re-read the ENTIRE
  // six-month mailbox (a full quota-minute) inside this 120s function, which is
  // why the advertised recovery for a timeout was itself the most timeout-prone
  // route in the app. The bounded re-read inside synthesizeProfile remains only
  // for rows that predate the evidence column.
  let distilled;
  try {
    const { data: row } = await supabase
      .from("profile_drafts")
      .select("evidence")
      .eq("entity_id", viewer.entityId)
      .maybeSingle();
    if (row?.evidence) distilled = DistilledEvidenceSchema.parse(row.evidence);
  } catch (err) {
    console.warn("[onboarding] stored evidence unreadable; falling back to a bounded re-read:", err);
  }

  let synthesis;
  try {
    synthesis = await synthesizeProfile({
      accessToken,
      email: viewer.email,
      name: session.user.name ?? null,
      guidance,
      distilled,
      deadline: Date.now() + 100_000,
    });
  } catch (err) {
    // Full detail to the log; the client gets a sanitized line — the fallback
    // Gmail re-read can throw googleFetch errors carrying the request URL and
    // Google's raw response body.
    console.error("[onboarding] regenerate failed:", err);
    return NextResponse.json({ error: publicGoogleErrorMessage(err) }, { status: 502 });
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
