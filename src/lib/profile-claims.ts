import type { SupabaseClient } from "@supabase/supabase-js";
import { writeClaims, projectDisplayName, type ClaimInput } from "./claims";
import type { ProfileDraft } from "./synthesize-profile";

/**
 * Turn a confirmed profile draft into claims.
 *
 * Runs only after the user has seen the draft and pressed Confirm — before that the
 * draft lives in `profile_drafts` and is visible to nobody. This is the moment it
 * becomes part of the graph.
 *
 * ## Why `method: "inferred"` and not `"self_reported"`
 *
 * The model inferred these facts from mailbox metadata; the user reviewed them and
 * declined to reject them. That is meaningfully weaker than the user typing them, and
 * `resolved_attributes` ranks `self_reported` above everything else precisely so a
 * person's own words win over an inference. Labelling a reviewed inference as
 * self-reported would let it outrank something the user later actually states.
 *
 * Confidence 0.75 rather than 0.7: a human looked at it. Not higher, because "didn't
 * object" is weak assent — people confirm to get through onboarding.
 *
 * ## Attribute mapping
 *
 * `headline`, `bio`, and `goals` already exist in the vocabulary `resolved-profile.ts`
 * reads. `expertise` and `interests` were added to it as array attributes; they are
 * stored separately so the admin entity view can show what each was inferred from,
 * and folded into `tags` when building the flat `Person` view that `rerank()` wants.
 *
 * `suggestedIntros` is still deliberately NOT written here. SPEC §10: "a reason is not
 * a claim." A guess about what introductions someone might like is not a fact about
 * them, and writing it would put model speculation into the controlled vocabulary the
 * matching layer reads as ground truth.
 *
 * What changed: the confirm screen now seeds an editable box with those suggestions,
 * and what the user submits is written by `writeAsks` to the `asks` table (migration
 * 0038) — the `asks`-shaped home SPEC §10 pointed at. That is authorship, not
 * inference, so it lives outside claims and never touches this function.
 *
 * The user can also dismiss individual expertise/interests/goals on that screen. Those
 * arrive as `hidden` and are skipped before any claim is built, so a rejected item is
 * never written rather than written-and-superseded.
 */

const SCALAR_FIELDS = ["headline", "bio"] as const;
const ARRAY_FIELDS = ["goals", "expertise", "interests"] as const;

/** Reviewed-but-inferred: see the header. */
const CONFIRMED_CONFIDENCE = 0.75;

export interface WriteProfileResult {
  written: number;
  failed: { attribute: string; error: string }[];
}

export async function writeProfileClaims(
  client: SupabaseClient,
  opts: {
    entityId: string;
    draft: ProfileDraft;
    /** Sentence naming what the synthesis actually saw — the review queue needs it. */
    evidence: string;
    /** Model id, so a bad prompt version can be traced back from the claims. */
    model: string;
    /**
     * Array-field values the user dismissed on the review screen, lowercased for
     * comparison. These are never written — not written-then-superseded. A claim the
     * person rejected before it existed has no history worth keeping, and writing it
     * would make it briefly true and permanently visible in the claim log.
     */
    hidden?: Set<string>;
  },
): Promise<WriteProfileResult> {
  const observedAt = new Date().toISOString();
  const source = `profile:${opts.model}`;
  const claims: ClaimInput[] = [];

  const base = {
    subjectId: opts.entityId,
    source,
    method: "inferred" as const,
    confidence: CONFIRMED_CONFIDENCE,
    observedAt,
    evidence: opts.evidence,
  };

  for (const field of SCALAR_FIELDS) {
    const value = opts.draft[field]?.trim();
    if (!value) continue;
    claims.push({ ...base, attribute: field, value });
  }

  // One claim per array item, not one claim holding an array — so adding a goal later
  // is a new claim rather than a rewrite, which is what append-only means here.
  for (const field of ARRAY_FIELDS) {
    for (const item of opts.draft[field] ?? []) {
      const value = typeof item === "string" ? item.trim() : "";
      if (!value) continue;
      if (opts.hidden?.has(value.toLowerCase())) continue;
      claims.push({ ...base, attribute: field, value });
    }
  }

  if (!claims.length) return { written: 0, failed: [] };

  const { written, failed } = await writeClaims(client, claims);

  // display_name is projected from claims, never written by hand. Nothing above
  // writes a `name` claim — Gmail ingest already did that, or the entity falls back
  // to its email — but the projection is re-run so a name claim that arrived between
  // ingest and confirm is picked up.
  await projectDisplayName(client, opts.entityId);

  return {
    written: written.length,
    failed: failed.map((f) => ({ attribute: f.input.attribute, error: f.error })),
  };
}
