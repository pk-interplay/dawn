import { supabase } from "../lib/supabase";
import type { Person } from "../lib/types";
import { fetchCandidates, fetchCalibration } from "../lib/candidates";
import { rerank, validateMatches } from "../lib/rerank";

async function matchPerson(person: Person) {
  const { candidates } = await fetchCandidates(supabase, person);
  if (candidates.length === 0) {
    console.log(`No candidates found for ${person.name}`);
    return;
  }

  const calibration = await fetchCalibration(supabase, person.id);
  const ranked = await rerank(person, candidates, calibration);
  const { valid, notes } = validateMatches(ranked, candidates);
  for (const note of notes) console.log(`  ${note}`);

  const rows = valid.map((m) => ({
    person_a_id: person.id,
    person_b_id: m.candidate_id,
    score: m.score,
    direction: m.direction,
    rationale: m.rationale,
  }));

  const { error } = await supabase.from("matches").upsert(rows, { onConflict: "person_low,person_high" });
  if (error) throw error;
  console.log(`${person.name}: saved ${rows.length} matches`);
}

async function main() {
  const personArgIndex = process.argv.indexOf("--person");
  const all = process.argv.includes("--all");

  if (personArgIndex !== -1) {
    const id = process.argv[personArgIndex + 1];
    const { data, error } = await supabase.from("people").select("*").eq("id", id).single();
    if (error) throw error;
    await matchPerson(data as Person);
  } else if (all) {
    const { data, error } = await supabase.from("people").select("*");
    if (error) throw error;
    for (const person of (data as Person[]) ?? []) {
      await matchPerson(person);
    }
  } else {
    console.error("Usage: npm run match -- --person <uuid> | --all");
    process.exit(1);
  }
}

main();
