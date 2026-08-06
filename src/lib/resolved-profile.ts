import type { SupabaseClient } from "@supabase/supabase-js";
import type { Person } from "./types";

/**
 * Nexus v0.2 build step 3 (SPEC.md §5 row 2: "port the query underneath it,
 * keep the function"). Flattens `resolved_attributes` rows for an entity into
 * the same flat shape `rerank()` already expects, so rerank.ts and
 * validateMatches stay byte-for-byte unchanged — only the retrieval underneath
 * them moves from `people` to the claims graph.
 *
 * Array-valued attributes (`goals`, `background`, `tags`, `ask_must_haves`,
 * `ask_nice_to_haves`) are stored as one claim per item rather than one claim
 * holding a JSON array, so a single new goal is a new claim rather than a
 * rewrite of an existing one — consistent with claims being append-only facts,
 * not mutable records.
 *
 * `paused`/`is_synthetic`/`is_demo_persona` have no home in the claims model
 * yet (open question in the plan: they're operational eligibility flags, not
 * reported facts) — defaulted here rather than sourced, since fetchCandidates'
 * eligibility filtering is out of scope for steps 1-3 against entities.
 */

const SCALAR_ATTRS = [
  "headline",
  "bio",
  "offering",
  "looking_for",
  "industry",
  "career_stage",
  "location",
  "meeting_format",
  "email",
  "timezone",
  "intro_cadence",
] as const;

const ARRAY_ATTRS = ["goals", "background", "tags", "ask_must_haves", "ask_nice_to_haves"] as const;

export async function buildPersonLikeView(client: SupabaseClient, subjectId: string): Promise<Person> {
  const { data, error } = await client
    .from("resolved_attributes")
    .select("attribute, value")
    .eq("subject_id", subjectId);
  if (error) throw new Error(`buildPersonLikeView failed: ${error.message}`);

  const rows = data ?? [];
  const scalar = new Map<string, unknown>();
  const arrays = new Map<string, unknown[]>();
  for (const row of rows) {
    const attr = row.attribute as string;
    if (!(SCALAR_ATTRS as readonly string[]).includes(attr) && !(ARRAY_ATTRS as readonly string[]).includes(attr)) {
      continue; // not in the recognised attribute vocabulary this view understands
    }
    if ((ARRAY_ATTRS as readonly string[]).includes(attr)) {
      arrays.set(attr, [...(arrays.get(attr) ?? []), row.value]);
    } else {
      scalar.set(attr, row.value);
    }
  }

  const { data: entity, error: entityError } = await client
    .from("entities")
    .select("id, display_name")
    .eq("id", subjectId)
    .single();
  if (entityError) throw new Error(`buildPersonLikeView entity lookup failed: ${entityError.message}`);

  const s = (attr: string) => (scalar.get(attr) as string | undefined) ?? null;
  const a = (attr: string) => (arrays.get(attr) as string[] | undefined) ?? [];

  return {
    id: entity.id,
    name: entity.display_name ?? s("email") ?? "Unknown",
    headline: s("headline"),
    bio: s("bio"),
    offering: s("offering"),
    looking_for: s("looking_for"),
    goals: a("goals"),
    background: a("background"),
    tags: a("tags"),
    industry: s("industry"),
    career_stage: s("career_stage"),
    location: s("location"),
    meeting_format: s("meeting_format"),
    ask_must_haves: a("ask_must_haves"),
    ask_nice_to_haves: a("ask_nice_to_haves"),
    email: s("email"),
    user_id: null,
    timezone: s("timezone"),
    paused: false,
    intro_cadence: s("intro_cadence") ?? "weekly",
    is_synthetic: false,
    is_demo_persona: false,
    embedding_offering: null,
    embedding_looking_for: null,
    embedding_tags: null,
  };
}
