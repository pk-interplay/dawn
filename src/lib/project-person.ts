import type { SupabaseClient } from "@supabase/supabase-js";

import { embed } from "./openai";

/**
 * Claims → the `people` row that matching actually reads.
 *
 * ## The bug this closes
 *
 * Editing your profile wrote claims and refreshed `entities.embedding`, and then
 * nothing happened. The live matcher — `/api/cron/run-matches` → candidates.ts — selects
 * from `people` and ranks on `people.embedding_offering` / `people.embedding_looking_for`.
 * Those two columns were only ever written by the seed scripts, the persona generators,
 * mcp/server.ts and `POST /api/people`. No edit path touched them. So a member could
 * rewrite their entire profile, watch it save, and get introduced on the strength of
 * whatever they said the day they were created. (candidates-entities.ts DOES read the
 * entity embedding, and is imported by nothing.)
 *
 * Until the matcher is ported onto the claims model wholesale, an edit has to land in
 * both places. This is the bridge: it re-projects the resolved profile onto the mapped
 * `people` row and rebuilds the two embeddings the ranker uses.
 *
 * ## Why the embedding strings are copy-pasted
 *
 * The two `embed()` inputs below are byte-identical in shape to the ones in
 * `POST /api/people` (and seed.ts, and the persona scripts). They have to be: every
 * existing vector in those columns was built with that phrasing, and similarity is only
 * meaningful between vectors built the same way. Changing the wording here without
 * re-embedding the whole table would quietly degrade every comparison against members
 * this function has not touched yet.
 *
 * ## Columns it deliberately does not write
 *
 * `paused`, `intro_cadence`, `meeting_format`, `timezone`, `is_synthetic`,
 * `is_demo_persona` and `background` are operational or settings state, not profile
 * claims. A projection that reset them would turn "I edited my bio" into "I un-paused
 * myself", so they are set on INSERT only and never on update.
 */

export interface ProjectedProfile {
  name: string | null;
  email: string | null;
  headline: string;
  bio: string;
  offering: string;
  looking_for: string;
  location: string;
  goals: string[];
  tags: string[];
  ask_must_haves: string[];
  ask_nice_to_haves: string[];
}

export interface ProjectPersonResult {
  personId: string | null;
  created: boolean;
  /** Null when the profile has no ask and no offer yet — nothing to embed on. */
  embedded: boolean;
}

export async function projectPersonFromProfile(
  client: SupabaseClient,
  entityId: string,
  profile: ProjectedProfile,
): Promise<ProjectPersonResult> {
  const personId = await resolvePersonId(client, entityId, profile.email);

  const columns: Record<string, unknown> = {
    headline: profile.headline || null,
    bio: profile.bio || null,
    offering: profile.offering || null,
    looking_for: profile.looking_for || null,
    location: profile.location || null,
    goals: profile.goals,
    tags: profile.tags,
    ask_must_haves: profile.ask_must_haves,
    ask_nice_to_haves: profile.ask_nice_to_haves,
  };
  if (profile.name) columns.name = profile.name;
  if (profile.email) columns.email = profile.email;

  // Both directions are needed to be matchable at all: run-matches skips any row missing
  // either one. Embedding a blank field would bury a real vector under a meaningless
  // one, so a member with only half a profile stays skipped until they write the rest.
  const canEmbed = Boolean(profile.offering.trim() && profile.looking_for.trim());
  if (canEmbed) {
    const goalsText = profile.goals.join(". ");
    const [embeddingOffering, embeddingLookingFor] = await Promise.all([
      embed(`${profile.headline}. Offers: ${profile.offering}. Relevant background: ${profile.bio}`),
      embed(`Looking for: ${profile.looking_for}. Goals: ${goalsText}. Context: ${profile.bio}`),
    ]);
    columns.embedding_offering = embeddingOffering;
    columns.embedding_looking_for = embeddingLookingFor;
  }

  if (personId) {
    const { error } = await client.from("people").update(columns).eq("id", personId);
    if (error) throw new Error(`projectPersonFromProfile update failed: ${error.message}`);
    return { personId, created: false, embedded: canEmbed };
  }

  // No row yet: a member who signed up through onboarding rather than the seed scripts
  // has never existed in `people`, which means the cron has never once considered them.
  if (!profile.name && !profile.email) {
    return { personId: null, created: false, embedded: false };
  }

  const { data, error } = await client
    .from("people")
    .insert({
      ...columns,
      name: profile.name ?? profile.email,
      background: [],
      paused: false,
      intro_cadence: "weekly",
      is_synthetic: false,
      is_demo_persona: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`projectPersonFromProfile insert failed: ${error.message}`);

  const newId = data.id as string;
  const { error: mapError } = await client
    .from("people_entity_map")
    .insert({ person_id: newId, entity_id: entityId });
  if (mapError) throw new Error(`people_entity_map insert failed: ${mapError.message}`);

  return { personId: newId, created: true, embedded: canEmbed };
}

/**
 * The map is authoritative. Email is the fallback for members who predate it — and when
 * it hits, the map row is written so the lookup is a single hop next time. Resolving by
 * email in both directions is the same rule backfill-entities-from-people.ts depends on
 * to stop one human from splitting into two records.
 *
 * Returning null here is not "no match" — it is "no match, go create one". So every way
 * this function can be wrong ends with a duplicate `people` row for someone who already
 * had one, which is the precise bug migration 0016 was written to end. Both lookups
 * below are therefore deliberately generous, and the one write is deliberately strict.
 */
async function resolvePersonId(
  client: SupabaseClient,
  entityId: string,
  email: string | null,
): Promise<string | null> {
  const { data: mapped, error } = await client
    .from("people_entity_map")
    .select("person_id")
    .eq("entity_id", entityId)
    .maybeSingle();
  if (error) throw new Error(`people_entity_map lookup failed: ${error.message}`);
  if (mapped) return mapped.person_id as string;

  if (!email) return null;
  // `ilike`, not `eq`: uniqueness on this table is `lower(email)` (migration 0016), and
  // an `eq` miss on a case difference doesn't fail — it falls through to INSERT and
  // creates the second row that index exists to forbid. The insert would then bounce off
  // the index into a swallowed catch, so the member would watch a save succeed and
  // change nothing. Inbound triage resolves senders the same way for the same reason.
  const { data: byEmail, error: emailError } = await client
    .from("people")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (emailError) throw new Error(`people email lookup failed: ${emailError.message}`);
  if (!byEmail) return null;

  const personId = byEmail.id as string;

  // `person_id` is the PRIMARY KEY of the map (0028), so a person belongs to exactly one
  // entity. If this row is already spoken for by somebody else, we have two entities
  // claiming one human — and blindly inserting would fail with a message containing
  // "duplicate", which a tolerant catch would read as "already mapped, carry on" and
  // then project this entity's profile onto another person's row. That is the
  // split-identity failure this codebase has already been bitten by once, so it is
  // raised rather than absorbed.
  const { data: existing, error: existingError } = await client
    .from("people_entity_map")
    .select("entity_id")
    .eq("person_id", personId)
    .maybeSingle();
  if (existingError) throw new Error(`people_entity_map lookup failed: ${existingError.message}`);
  if (existing) {
    if (existing.entity_id === entityId) return personId;
    throw new Error(
      `people row ${personId} (${email}) is already mapped to entity ${existing.entity_id}, ` +
        `but entity ${entityId} resolves to the same email — refusing to project across two identities.`,
    );
  }

  const { error: mapError } = await client
    .from("people_entity_map")
    .insert({ person_id: personId, entity_id: entityId });
  if (mapError) throw new Error(`people_entity_map backfill failed: ${mapError.message}`);
  return personId;
}
