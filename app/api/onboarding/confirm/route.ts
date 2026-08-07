import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../../src/lib/entity-identity";
import { writeProfileClaims } from "../../../../src/lib/profile-claims";
import { summarizeEntity } from "../../../../src/lib/summarize-entity";
import { ProfileDraftSchema, SYNTHESIS_MODEL } from "../../../../src/lib/synthesize-profile";

/**
 * Onboarding step 2: the user pressed Confirm. This is where they join the network.
 *
 * Takes NO body. The draft is read from `profile_drafts` server-side rather than
 * accepted from the client — a client-supplied profile is a client-supplied set of
 * claims about a person, and this route writes with the service-role key. The button
 * confirms; it does not author.
 *
 * Three things happen, in a deliberate order:
 *   1. draft → claims (writeProfileClaims)
 *   2. entities.onboarded_at is stamped — this is what marks onboarding complete
 *   3. summarizeEntity() runs INLINE
 *
 * (3) is inline rather than deferred because the embedding is what makes this person
 * findable: `match_entities` skips rows where `embedding is null`, and the admin
 * constellation cannot place them. Deferring it to `after()` means a silent failure
 * leaves someone invisible in the network they were just told they had joined, with
 * nothing to indicate it. It is one Haiku call plus one embedding behind a screen that
 * is already saying "setting up", and it is wrapped so a failure does not un-confirm
 * the profile — the claims are already written and correct either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const viewer = await resolveViewerEntity(supabase, session);
  if (!viewer) {
    return NextResponse.json(
      { error: "No graph yet — run the Gmail sync first." },
      { status: 409 },
    );
  }

  const { data: row, error: readError } = await supabase
    .from("profile_drafts")
    .select("draft, model, created_at")
    .eq("entity_id", viewer.entityId)
    .maybeSingle();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { error: "That draft has expired. Regenerate it and confirm again." },
      { status: 409 },
    );
  }

  // Validate on the way out of the database, not just on the way in. The column is
  // jsonb, so a schema change or a hand-edited row would otherwise become claims.
  const parsed = ProfileDraftSchema.safeParse(row.draft);
  if (!parsed.success) {
    console.error("[onboarding] staged draft failed validation:", parsed.error.message);
    return NextResponse.json(
      { error: "That draft is no longer readable. Regenerate it and confirm again." },
      { status: 409 },
    );
  }

  // The staged row does not carry the per-run evidence counts, and re-deriving them
  // would mean re-reading Gmail just to write a sentence. The model id is what actually
  // matters for tracing a claim back to a prompt version, and that IS stored.
  const model = (row.model as string) ?? SYNTHESIS_MODEL;
  const evidence =
    `Inferred by ${model} from Gmail/Calendar metadata — outbound subject lines, ` +
    `correspondent organisations, and meeting titles. No message bodies were read. ` +
    `Reviewed and confirmed by the user during onboarding.`;

  const result = await writeProfileClaims(supabase, {
    entityId: viewer.entityId,
    draft: parsed.data,
    evidence,
    model,
  });

  const { error: stampError } = await supabase
    .from("entities")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", viewer.entityId);
  if (stampError) {
    return NextResponse.json({ error: stampError.message }, { status: 500 });
  }

  // Draft has become claims; the staging row is now a stale duplicate.
  await supabase.from("profile_drafts").delete().eq("entity_id", viewer.entityId);

  let embedded = false;
  try {
    await summarizeEntity(supabase, viewer.entityId);
    embedded = true;
  } catch (err) {
    // Not fatal, but it does mean this person is not yet findable by semantic search.
    // `npm run summarize:entities` and the admin page's bounded summarize action are
    // both able to fix it after the fact.
    console.error("[onboarding] summarizeEntity failed:", err);
  }

  return NextResponse.json({
    ok: true,
    entityId: viewer.entityId,
    claimsWritten: result.written,
    claimsFailed: result.failed,
    embedded,
  });
}
