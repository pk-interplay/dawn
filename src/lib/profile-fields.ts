import { z } from "zod";

/**
 * The profile vocabulary: which attributes a member may state about themselves, what
 * they're called, and what a valid value looks like.
 *
 * Split out of profile-edit.ts so the form can import it. That file reaches Supabase and
 * (through refreshProfileEmbedding) the Anthropic and OpenAI clients; a client component
 * importing it for a label would drag all of that toward the browser bundle. Everything
 * here is constants and a zod schema — no I/O, safe on either side.
 */

export const SCALAR_FIELDS = [
  "headline",
  "bio",
  "looking_for",
  "offering",
  "location",
] as const;

export const LIST_FIELDS = [
  "goals",
  "ask_must_haves",
  "ask_nice_to_haves",
  "expertise",
  "interests",
] as const;

export type ScalarField = (typeof SCALAR_FIELDS)[number];
export type ListField = (typeof LIST_FIELDS)[number];

/** Human labels, shared by the form and the agent's tool description. */
export const FIELD_LABELS: Record<ScalarField | ListField, string> = {
  headline: "Headline",
  bio: "Bio",
  looking_for: "What you're looking for",
  offering: "What you can offer",
  location: "Location",
  goals: "What you're working on",
  ask_must_haves: "Asks — must haves",
  ask_nice_to_haves: "Asks — nice to haves",
  expertise: "Expertise",
  interests: "Interests",
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
    ask_must_haves: listValue.optional(),
    ask_nice_to_haves: listValue.optional(),
    expertise: listValue.optional(),
    interests: listValue.optional(),
  })
  .strict();

export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

