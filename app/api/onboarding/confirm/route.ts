import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { supabase } from "../../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../../src/lib/entity-identity";
import { writeProfileClaims } from "../../../../src/lib/profile-claims";
import { parseAsks, writeAsks } from "../../../../src/lib/asks";
import { syncProfileDownstream } from "../../../../src/lib/profile-edit";
import { ProfileDraftSchema, SYNTHESIS_MODEL } from "../../../../src/lib/synthesize-profile";

/**
 * Onboarding step 2: the user pressed Confirm. This is where they join the network.
 *
 * The draft is still read from `profile_drafts` server-side, never accepted from the
 * client — a client-supplied profile is a client-supplied set of claims about a person,
 * and this route writes with the service-role key.
 *
 * The body it now takes does not weaken that. It carries two things, and neither can
 * author a claim:
 *
 *   `hidden` — array-field values the user dismissed. It can only ever *subtract* from
 *     what the staged draft already says, so the worst a hostile client achieves is a
 *     thinner profile of itself.
 *   `asks`  — free text the user wrote about what they want. This is authorship, which
 *     is exactly why it does not become a claim: it goes to the `asks` table (migration
 *     0038, SPEC §10) as self-authored text, outside the vocabulary matching trusts.
 *
 * So the rule holds in the form that matters: the button still cannot invent a fact
 * about a person. It can only narrow one, or record a want alongside it.
 *
 * Three things happen, in a deliberate order:
 *   1. draft → claims (writeProfileClaims)
 *   2. entities.onboarded_at is stamped — this is what marks onboarding complete
 *   3. syncProfileDownstream() runs INLINE — the `people` row, then the embedding
 *
 * (3) is inline rather than deferred because both halves are what make this person
 * exist to the rest of the system: `match_entities` skips rows where `embedding is
 * null` and the admin constellation cannot place them, while the matching cron reads
 * `people` and cannot see anyone who has no row there at all. Deferring it to `after()`
 * means a silent failure leaves someone invisible in the network they were just told
 * they had joined, with nothing to indicate it. It is a couple of model calls behind a
 * screen that is already saying "setting up", and it is wrapped so a failure does not
 * un-confirm the profile — the claims are already written and correct either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Tolerant of no body at all: Regenerate-then-Confirm and any older client still
  // post empty, and that should mean "confirm the draft as staged", not a 400.
  const body = await request
    .json()
    .then((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {}))
    .catch(() => ({}) as Record<string, unknown>);

  const hidden = new Set(
    (Array.isArray(body.hidden) ? body.hidden : [])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  const asks = parseAsks(typeof body.asks === "string" ? body.asks : "");

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
    hidden,
  });

  // After the claims, and non-fatally. The profile is what joins someone to the
  // network; an ask that failed to save is a line of text they can retype, and it must
  // not un-confirm a profile that is already written and correct.
  let asksWritten = 0;
  try {
    ({ written: asksWritten } = await writeAsks(supabase, {
      entityId: viewer.entityId,
      asks,
    }));
  } catch (err) {
    console.error("[onboarding] failed to write asks:", err);
  }

  const { error: stampError } = await supabase
    .from("entities")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", viewer.entityId);
  if (stampError) {
    return NextResponse.json({ error: stampError.message }, { status: 500 });
  }

  // Draft has become claims; the staging row is now a stale duplicate.
  await supabase.from("profile_drafts").delete().eq("entity_id", viewer.entityId);

  // Everything downstream of a profile write, not just the entity embedding: this is
  // also the moment a member first gets a `people` row, without which the matching cron
  // has literally never seen them (project-person.ts). They will still be skipped there
  // until they say what they offer and want — onboarding infers neither — but they now
  // exist to be skipped, which is the difference between "not ready" and "not present".
  // Individually caught inside, and non-fatal here: an unembedded profile is fixable
  // after the fact by `npm run summarize:entities` or the admin summarize action, and
  // must not un-confirm a profile that is already written and correct.
  const sync = await syncProfileDownstream(supabase, viewer.entityId);
  const embedded = sync.summarized;

  return NextResponse.json({
    ok: true,
    entityId: viewer.entityId,
    claimsWritten: result.written,
    claimsFailed: result.failed,
    asksWritten,
    embedded,
  });
}
