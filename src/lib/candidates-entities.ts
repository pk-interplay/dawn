import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candidate, Person } from "./types";
import type { CalibrationExample } from "./rerank";

/**
 * Nexus v0.2 build step 3 (SPEC.md §5 row 2, §7 step 3): the entities-based
 * candidate/calibration retrieval that `rank_matches` (rerank.ts, unchanged)
 * queries against instead of `people`/`matches`.
 *
 * Deliberately a NEW file rather than a modification of candidates.ts: the
 * live `/api/cron/run-matches` path keeps reading `people`/`matches` and
 * serving real traffic while this path is validated against the exported
 * eval fixtures (SPEC's own "the system runs after every step" rule) — the
 * cutover from one to the other is a build-step-4/5 decision, not this one.
 */

const CANDIDATE_LIMIT = 10;
const CANDIDATE_OVERFETCH = 3;
const CALIBRATION_LIMIT = 8;

export async function fetchCandidatesForEntity(client: SupabaseClient, person: Person) {
  const overfetch = CANDIDATE_LIMIT * CANDIDATE_OVERFETCH;
  if (!person.embedding_offering && !person.embedding_looking_for) {
    // No embedding yet (summarizeEntity hasn't run for this entity) — nothing to
    // rank against. Callers should run summarizeEntity first rather than treat
    // an empty candidate list as "no matches exist".
    return { candidates: [] as Candidate[], count: 0 };
  }

  const queryEmbedding = person.embedding_offering ?? person.embedding_looking_for;
  const { data, error } = await client.rpc("match_entities", {
    query_embedding: queryEmbedding,
    exclude_id: person.id,
    match_count: overfetch,
  });
  if (error) throw new Error(error.message);

  const rejectedIds = await fetchRejectedEntityIds(client, person.id);
  const candidates: Candidate[] = (data ?? [])
    .filter((row: { id: string }) => !rejectedIds.has(row.id))
    .slice(0, CANDIDATE_LIMIT)
    .map((row: { id: string; display_name: string; summary: string; similarity: number }) => ({
      id: row.id,
      name: row.display_name,
      // Single embedding collapses the offering/wants direction distinction at
      // this stage (see migration 0027's comment) — surfaced_via is reported as
      // "mutual" rather than invented, since there's no directional signal here.
      surfaced_via: "mutual" as const,
      similarity: row.similarity,
      bio: row.summary,
      // Everything else rerank.ts's prompt reads comes from resolved-profile.ts
      // when the candidate itself is expanded, not from this row.
      headline: null,
      offering: null,
      looking_for: null,
      goals: [],
      background: [],
      tags: [],
      industry: null,
      career_stage: null,
      location: null,
      meeting_format: null,
      ask_must_haves: [],
      ask_nice_to_haves: [],
      email: null,
      user_id: null,
      timezone: null,
      paused: false,
      intro_cadence: "weekly",
      is_synthetic: false,
      is_demo_persona: false,
      embedding_offering: null,
      embedding_looking_for: null,
      embedding_tags: null,
    }));

  return { candidates, count: candidates.length };
}

/**
 * Rejected pairs, via `people_entity_map` (migration 0028) rather than a
 * claims-modeled outcome: a match is a relationship judgment between two
 * entities, not an attribute of one, so it stays in `matches` until build
 * step 5 introduces `asks` — see the plan's "Data migration" section.
 */
async function fetchRejectedEntityIds(client: SupabaseClient, entityId: string): Promise<Set<string>> {
  const { data: mapRow, error: mapError } = await client
    .from("people_entity_map")
    .select("person_id")
    .eq("entity_id", entityId)
    .maybeSingle();
  if (mapError) throw new Error(mapError.message);
  if (!mapRow) return new Set(); // entity has no backfilled person_id — nothing to look up yet

  const personId = mapRow.person_id as string;
  const { data: rejected, error } = await client
    .from("matches")
    .select("person_a_id, person_b_id")
    .eq("status", "rejected")
    .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`);
  if (error) throw new Error(error.message);

  const otherPersonIds = (rejected ?? []).map((m) => (m.person_a_id === personId ? m.person_b_id : m.person_a_id));
  if (!otherPersonIds.length) return new Set();

  const { data: entityRows, error: entityError } = await client
    .from("people_entity_map")
    .select("entity_id")
    .in("person_id", otherPersonIds);
  if (entityError) throw new Error(entityError.message);
  return new Set((entityRows ?? []).map((r) => r.entity_id as string));
}

export async function fetchCalibrationForEntity(client: SupabaseClient, entityId: string): Promise<CalibrationExample[]> {
  const { data: mapRow, error: mapError } = await client
    .from("people_entity_map")
    .select("person_id")
    .eq("entity_id", entityId)
    .maybeSingle();
  if (mapError) throw new Error(mapError.message);
  if (!mapRow) return [];

  const personId = mapRow.person_id as string;
  const { data: saved, error } = await client
    .from("matches")
    .select("person_a_id, person_b_id, status, rationale")
    .neq("status", "suggested")
    .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
    .order("created_at", { ascending: false })
    .limit(CALIBRATION_LIMIT);
  if (error) throw new Error(error.message);
  if (!saved?.length) return [];

  const otherIds = saved.map((m) => (m.person_a_id === personId ? m.person_b_id : m.person_a_id));
  const { data: others, error: othersError } = await client.from("people").select("id, name").in("id", otherIds);
  if (othersError) throw new Error(othersError.message);

  const nameById = new Map((others ?? []).map((p) => [p.id, p.name]));
  return saved.map((m) => ({
    other_name: nameById.get(m.person_a_id === personId ? m.person_b_id : m.person_a_id) ?? "unknown",
    status: m.status,
    rationale: m.rationale,
  }));
}
