import { z } from "zod";

/**
 * The profile vocabulary: which attributes a member may state about themselves, what
 * they're called, and what a valid value looks like.
 *
 * Split out of profile-edit.ts so the form can import it. That file reaches Supabase and
 * (through syncProfileDownstream) the Anthropic and OpenAI clients; a client component
 * importing it for a label would drag all of that toward the browser bundle. Everything
 * here is constants and a zod schema — no I/O, safe on either side.
 *
 * ## Stated vs. derived
 *
 * The form used to ask for the same thing three times: `looking_for` in prose, then the
 * same ask taken apart by hand into `ask_must_haves` and `ask_nice_to_haves`. That
 * decomposition is a machine's job — rerank.ts weighs must-haves heavily, so they have
 * to exist, but nobody should have to write their ask twice to get them.
 *
 * So the asks are DERIVED (derive-asks.ts) from `looking_for`, and land as `inferred`
 * claims. They stay in `ProfilePatchSchema` on purpose: if the member corrects them —
 * in the form or by telling Dawn in chat — that write is `self_reported`, which outranks
 * the inference and switches the deriver off for that field permanently. Stating beats
 * inferring here exactly like it does everywhere else in the claims model.
 */

export const SCALAR_FIELDS = [
  "headline",
  "bio",
  "looking_for",
  "offering",
  "location",
] as const;

/** Lists the member edits directly. */
export const EDITABLE_LIST_FIELDS = ["goals", "tags"] as const;

/** Lists Dawn derives from `looking_for` unless the member has stated them. */
export const DERIVED_LIST_FIELDS = ["ask_must_haves", "ask_nice_to_haves"] as const;

export const LIST_FIELDS = [...EDITABLE_LIST_FIELDS, ...DERIVED_LIST_FIELDS] as const;

/**
 * Older attributes folded into `tags`. `resolved-profile.ts` already unions all three
 * into one `tags` array for rerank(), so they were never two different things to the
 * matcher — only to the form. Editing `tags` retires claims under these names too, which
 * makes the merge self-migrating: nobody has to backfill.
 */
export const MERGED_INTO_TAGS = ["expertise", "interests"] as const;

export type ScalarField = (typeof SCALAR_FIELDS)[number];
export type ListField = (typeof LIST_FIELDS)[number];
export type EditableListField = (typeof EDITABLE_LIST_FIELDS)[number];
export type DerivedListField = (typeof DERIVED_LIST_FIELDS)[number];

/** Human labels, shared by the form and the agent's tool description. */
export const FIELD_LABELS: Record<ScalarField | ListField, string> = {
  headline: "Headline",
  bio: "Bio",
  looking_for: "What you're looking for",
  offering: "What you can offer",
  location: "Location",
  goals: "What you're working on",
  tags: "Topics",
  ask_must_haves: "Must haves",
  ask_nice_to_haves: "Nice to haves",
};

/** Long enough for a real bio, short enough that nobody pastes a CV into a claim. */
const MAX_SCALAR_LENGTH = 2000;
const MAX_ITEM_LENGTH = 280;
const MAX_ITEMS = 20;

const scalarValue = z.string().trim().max(MAX_SCALAR_LENGTH);
const listValue = z.array(z.string().trim().min(1).max(MAX_ITEM_LENGTH)).max(MAX_ITEMS);

/**
 * A patch, not a whole profile: an absent key means "leave it alone", which is what
 * makes the same shape usable by both the form (sends everything) and the agent (sends
 * the one thing you mentioned). An empty string or empty array is a real instruction —
 * clear that field.
 */
export const ProfilePatchSchema = z
  .object({
    headline: scalarValue.optional(),
    bio: scalarValue.optional(),
    looking_for: scalarValue.optional(),
    offering: scalarValue.optional(),
    location: scalarValue.optional(),
    goals: listValue.optional(),
    tags: listValue.optional(),
    ask_must_haves: listValue.optional(),
    ask_nice_to_haves: listValue.optional(),
  })
  .strict();

export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;
