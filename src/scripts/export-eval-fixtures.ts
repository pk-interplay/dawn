// Rescue the only labeled data dawn-v0 ever produced, before the schema is wiped.
//
// Build plan §3: the Nexus database is greenfield — `matches` and the other ten
// legacy tables go away. Almost none of it is worth keeping. The exception is
// `matches` rows that reached `accepted` or `rejected`, because those statuses
// were written by `recordMatchOutcome` from a real human replying to a real
// email. That is a genuine judgment about a genuine pair, and there is no way to
// manufacture more of them: spec §7.3's held-out sets otherwise start empty, and
// at the PRD's target of 100 intros/month the loop only yields ~1,200 examples a
// year (spec §12).
//
// Run this BEFORE dropping anything. It is read-only and idempotent.
//
//   npm run export:eval-fixtures
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see .env.local)
//
// WHAT THIS DATA IS, precisely — it matters for how you evaluate against it:
//
//   Each row is ONE pair that Dawn proposed and a human then accepted or
//   declined. It is NOT a ranking. You cannot use it to check "did the model
//   return the right top-5", because nothing recorded which candidates lost.
//
//   What it DOES support:
//     * Pairwise preference — for a person with both an accept and a reject,
//       does rank_matches score the accepted counterpart higher?
//     * Regression floor — does a pair a human accepted still survive
//       validateMatches and clear a minimum score?
//     * Rationale quality — the stored rationale is what the human actually read
//       before saying yes or no, so it is a reference sample, not a gold answer.
//
// Do not overclaim it. Twelve honest pairs beat a synthetic thousand.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../lib/supabase";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../eval/fixtures/rank-matches");

/** The profile fields rank_matches actually receives (see src/lib/rerank.ts). */
const PERSON_FIELDS =
  "id, name, headline, bio, offering, looking_for, goals, background, tags, industry, career_stage, location, ask_must_haves, ask_nice_to_haves, is_synthetic, is_demo_persona";

interface MatchRow {
  id: string;
  person_a_id: string;
  person_b_id: string;
  score: number | null;
  direction: string;
  rationale: string;
  status: string;
  created_at: string;
}

type PersonRow = Record<string, unknown> & {
  id: string;
  name: string;
  is_synthetic: boolean | null;
  is_demo_persona: boolean | null;
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function main() {
  const { data: matchData, error: mErr } = await supabase
    .from("matches")
    .select("id, person_a_id, person_b_id, score, direction, rationale, status, created_at")
    .in("status", ["accepted", "rejected"])
    .order("created_at", { ascending: true });
  if (mErr) throw new Error(`matches read failed: ${mErr.message}`);

  const matches = (matchData ?? []) as MatchRow[];
  if (matches.length === 0) {
    // Not an error, but say so loudly. An empty export means the eval sets start
    // empty, which changes what Phase 1 can claim about §7.3.
    console.warn(
      "No accepted/rejected matches found. Either no intro ever resolved, or\n" +
        "recordMatchOutcome never wrote a status. Check before assuming this is\n" +
        "correct — the whole point of this script is that the data is unrecoverable.",
    );
    return;
  }

  const ids = [...new Set(matches.flatMap((m) => [m.person_a_id, m.person_b_id]))];
  const { data: peopleData, error: pErr } = await supabase
    .from("people")
    .select(PERSON_FIELDS)
    .in("id", ids);
  if (pErr) throw new Error(`people read failed: ${pErr.message}`);

  const byId = new Map((peopleData ?? []).map((p) => [(p as PersonRow).id, p as PersonRow]));

  await mkdir(OUT_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  const perPerson = new Map<string, { accepted: number; rejected: number }>();

  for (const m of matches) {
    const a = byId.get(m.person_a_id);
    const b = byId.get(m.person_b_id);
    // A cascade delete can leave a match whose people are gone. Half a pair is
    // not a usable example, so drop it rather than emit a fixture with nulls.
    if (!a || !b) {
      skipped++;
      continue;
    }

    // Cohort is recorded, not filtered on. A persona counterpart still carries a
    // real human's accept/reject decision on a real rationale — that judgment is
    // the label, and it is valid regardless of whether the counterpart existed.
    // Tagging it lets the eval split on it later; dropping it now would throw
    // away most of the set.
    const syntheticPair = Boolean(
      a.is_synthetic || b.is_synthetic || a.is_demo_persona || b.is_demo_persona,
    );

    const tally = perPerson.get(a.id) ?? { accepted: 0, rejected: 0 };
    if (m.status === "accepted") tally.accepted++;
    else tally.rejected++;
    perPerson.set(a.id, tally);

    const fixture = {
      $schema: "dawn-v0 match outcome -> nexus rank_matches fixture, v1",
      id: m.id,
      label: m.status, // 'accepted' | 'rejected' — the human's decision
      source: "dawn_v0:matches",
      observed_at: m.created_at,
      synthetic_counterpart: syntheticPair,
      proposed: {
        score: m.score === null ? null : Number(m.score),
        direction: m.direction,
        // Exactly the text the human read before deciding.
        rationale: m.rationale,
      },
      subject: a,
      counterpart: b,
    };

    const name = `${m.status}-${slug(a.name)}-${slug(b.name)}-${m.id.slice(0, 8)}.json`;
    await writeFile(resolve(OUT_DIR, name), JSON.stringify(fixture, null, 2) + "\n", "utf8");
    written++;
  }

  // Pairwise preference is the strongest eval this data supports, and it needs a
  // person with at least one of each. Report how many qualify so the number is
  // known rather than discovered later.
  const pairwiseReady = [...perPerson.values()].filter(
    (t) => t.accepted > 0 && t.rejected > 0,
  ).length;

  console.log(`Wrote ${written} fixture(s) to src/eval/fixtures/rank-matches/`);
  if (skipped) console.log(`Skipped ${skipped} match(es) whose people no longer exist.`);
  console.log(
    `\nSubjects with both an accept and a reject (usable for pairwise preference): ${pairwiseReady}`,
  );
  if (pairwiseReady === 0) {
    console.log(
      "  → None. The set still supports a regression floor (an accepted pair must\n" +
        "    survive validateMatches and clear a minimum score) but not pairwise\n" +
        "    ranking. Worth knowing before writing the eval.",
    );
  }
  console.log("\nCommit these. They cannot be regenerated once the schema is dropped.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
