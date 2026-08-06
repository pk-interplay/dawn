import { supabase } from "../lib/supabase";
import { writeClaims, type ClaimInput } from "../lib/claims";
import type { Person } from "../lib/types";

/**
 * Nexus v0.2 build step 1-3 backfill (plan §"Data migration"). A real
 * backfill, not a parallel schema: every `people` row becomes one `entities`
 * row plus one `claims` row per non-null column, and a `people_entity_map`
 * row so the ported matching path (candidates-entities.ts) can translate
 * `matches.person_a_id`/`person_b_id` into entity ids for calibration.
 *
 * `embedding_offering`/`embedding_looking_for` are deliberately NOT copied —
 * SPEC's `entities.embedding` is a single column, so every migrated entity
 * gets a fresh embedding from `npm run summarize:entities` after this runs,
 * derived from the now-migrated claims rather than the old two-column vectors.
 *
 * `is_synthetic`/`is_demo_persona`/`paused` are migrated as claims too (open
 * question in the plan: they're operational eligibility flags, not reported
 * facts, and a dedicated `entity_flags` table may be cleaner — flagged, not
 * resolved here) purely so a filter ported later has something to read.
 *
 * Idempotent: skips any `people` row already present in `people_entity_map`.
 */

const SCALAR_COLUMNS: (keyof Person)[] = [
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
];

const ARRAY_COLUMNS: (keyof Person)[] = ["goals", "background", "tags", "ask_must_haves", "ask_nice_to_haves"];

const FLAG_COLUMNS: (keyof Person)[] = ["is_synthetic", "is_demo_persona", "paused"];

async function backfillPerson(person: Person): Promise<{ entityId: string; claimCount: number }> {
  const { data: entity, error: entityError } = await supabase
    .from("entities")
    .insert({ kind: "person", display_name: person.name })
    .select("id")
    .single();
  if (entityError) throw new Error(`entity insert failed for ${person.name}: ${entityError.message}`);
  const entityId = entity.id as string;

  const observedAt = new Date().toISOString();
  const source = `migration:people.${person.id}`;
  const claims: ClaimInput[] = [];

  claims.push({
    subjectId: entityId,
    attribute: "name",
    value: person.name,
    source,
    method: "self_reported",
    confidence: 0.95,
    observedAt,
  });

  for (const col of SCALAR_COLUMNS) {
    const value = person[col];
    if (value === null || value === undefined || value === "") continue;
    claims.push({ subjectId: entityId, attribute: col, value, source, method: "self_reported", confidence: 0.9, observedAt });
  }

  for (const col of ARRAY_COLUMNS) {
    const value = person[col];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      claims.push({ subjectId: entityId, attribute: col, value: item, source, method: "self_reported", confidence: 0.9, observedAt });
    }
  }

  for (const col of FLAG_COLUMNS) {
    claims.push({ subjectId: entityId, attribute: col, value: person[col], source, method: "manual", confidence: 1, observedAt });
  }

  const { written, failed } = await writeClaims(supabase, claims);
  if (failed.length) {
    console.warn(`  ${failed.length} claim(s) failed for ${person.name}:`, failed.map((f) => f.error));
  }

  const { error: mapError } = await supabase.from("people_entity_map").insert({ person_id: person.id, entity_id: entityId });
  if (mapError) throw new Error(`people_entity_map insert failed for ${person.name}: ${mapError.message}`);

  return { entityId, claimCount: written.length };
}

async function main() {
  const { data: alreadyMapped, error: mapErr } = await supabase.from("people_entity_map").select("person_id");
  if (mapErr) throw mapErr;
  const done = new Set((alreadyMapped ?? []).map((r) => r.person_id as string));

  const { data: people, error } = await supabase.from("people").select("*");
  if (error) throw error;
  if (!people?.length) {
    console.log("No people rows to backfill.");
    return;
  }

  const todo = (people as Person[]).filter((p) => !done.has(p.id));
  console.log(`${people.length} people total, ${done.size} already backfilled, ${todo.length} to do.`);

  let ok = 0;
  const failed: string[] = [];
  for (const person of todo) {
    try {
      const { entityId, claimCount } = await backfillPerson(person);
      ok++;
      console.log(`${person.name} -> entity ${entityId} (${claimCount} claims)`);
    } catch (err) {
      // One bad person must not abort the batch — same posture used throughout
      // this migration (intro-flow.ts's send batch, network-ingest.ts's contact loop).
      failed.push(`${person.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nBackfilled ${ok}/${todo.length}.`);
  if (failed.length) {
    console.log(`Failed (${failed.length}):`);
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log("\nNext: npm run summarize:entities, then smoke-test rank_matches against the eval fixtures.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
