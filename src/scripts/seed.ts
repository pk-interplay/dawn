import { supabase } from "../lib/supabase";
import { embed } from "../lib/openai";
import { anthropic, textOf } from "../lib/anthropic";
import type { GeneratedProfile } from "../lib/types";
import type { MeetingFormat } from "../../lib/onboarding";

const SEED_COUNT = Number(process.env.SEED_COUNT ?? 150);
const BATCH_SIZE = 20;
const RESET = process.argv.includes("--reset");

const ARCHETYPES = [
  "seed-stage founder",
  "repeat founder",
  "angel investor",
  "engineer",
  "product manager",
  "designer",
  "researcher",
  "biz-dev / partnerships lead",
  "growth marketer",
  "operator / COO",
];

const INDUSTRIES = [
  "climate tech",
  "fintech",
  "health/biotech",
  "AI infrastructure",
  "consumer",
  "hardware",
  "creator economy",
  "enterprise SaaS",
];

const STAGES = ["early-career", "senior IC", "executive", "first-time founder", "repeat founder"];

// A real city, not a free-text guess. The model used to invent locations, which
// meant co-located pairs essentially never occurred — and the in-person path in
// `draftSchedulingEmail` compares these strings exactly, so seeded members have to
// draw from a shared list for coffee to ever be proposed. Weighted so the first few
// cities repeat and pairs actually collide.
const CITIES = [
  "New York",
  "New York",
  "New York",
  "San Francisco",
  "San Francisco",
  "San Francisco",
  "London",
  "London",
  "Berlin",
  "Singapore",
  "Remote",
];

// What each seeded member would accept for a first conversation, written as
// `person_preferences` rows with the same fixed values the real onboarding form
// produces. Real members answer this themselves; without it every synthetic pair
// has no format overlap and `draftSchedulingEmail` always falls back to proposing
// times, so none of the format-aware branches are reachable in testing.
//
// Cycled rather than random so a seeded run is reproducible, and heavy on coffee so
// co-located pairs actually hit the in-person path.
const FORMAT_SETS: MeetingFormat[][] = [
  ["in_person_coffee", "video_call"],
  ["in_person_coffee", "video_call", "phone_call"],
  ["video_call"],
  ["in_person_coffee", "phone_call"],
  ["async_email", "video_call"],
  ["phone_call", "video_call"],
  ["async_email"],
  ["in_person_coffee", "video_call"],
];

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
];

const CADENCES = ["weekly", "weekly", "biweekly", "monthly"]; // weighted toward weekly

// Optional: point the FIRST seeded person at a real inbox you control so you can
// run the live email round-trip test (reply "yes" and watch scheduling kick in).
const TEST_EMAIL = process.env.TEST_EMAIL;

// Synthetic, test-safe address derived from the name (the +dawn tag makes them
// easy to filter). These never receive real mail unless you set TEST_EMAIL.
function emailFor(name: string, i: number): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z]+/g, ".")
      .replace(/^\.|\.$/g, "") || `member${i}`;
  return `${slug}+dawn@example.com`;
}

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    profiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          headline: { type: "string" },
          bio: { type: "string" },
          offering: { type: "string" },
          looking_for: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          industry: { type: "string" },
          career_stage: { type: "string" },
          ask_must_haves: { type: "array", items: { type: "string" } },
          ask_nice_to_haves: { type: "array", items: { type: "string" } },
        },
        required: [
          "name",
          "headline",
          "bio",
          "offering",
          "looking_for",
          "tags",
          "industry",
          "career_stage",
          "ask_must_haves",
          "ask_nice_to_haves",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["profiles"],
  additionalProperties: false,
} as const;

function buildDiversityBriefs(total: number, batchSize: number): { text: string; count: number }[] {
  const briefs: { text: string; count: number }[] = [];
  let remaining = total;
  let i = 0;
  while (remaining > 0) {
    const count = Math.min(batchSize, remaining);
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    const industry = INDUSTRIES[i % INDUSTRIES.length];
    const stage = STAGES[i % STAGES.length];
    briefs.push({
      text: `Lean toward ${archetype} archetypes in ${industry}, career stage ${stage} — but vary within the batch too.`,
      count,
    });
    remaining -= count;
    i++;
  }
  return briefs;
}

async function generateBatch(brief: string, count: number): Promise<GeneratedProfile[]> {
  const resp = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema: PROFILE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Generate ${count} realistic, varied synthetic professional networking profiles for a startup-ecosystem intro platform. Diversity brief for this batch: ${brief}. Each profile needs a short "offering" (what they can give another person: expertise, intros, capital, time, mentorship) and a distinct "looking_for" (their current ask/intent) that is NOT just the inverse of offering. Also include: "industry" (a specific industry/vertical, not necessarily the batch's lean), "career_stage" (their actual career stage), "ask_must_haves" (1-3 short phrases naming the specific, non-negotiable parts of their ask — decomposed from "looking_for", not restating it wholesale), and "ask_nice_to_haves" (0-2 short phrases for bonus-but-not-required parts of their ask). Vary sentence structure and vocabulary across profiles — avoid template-y repetition.`,
      },
    ],
  });
  const parsed = JSON.parse(textOf(resp));
  return parsed.profiles;
}

/**
 * The rows a real member would create by answering the onboarding form.
 *
 * `format` is what makes the in-person / async branches in `draftSchedulingEmail`
 * reachable; `wants` is what makes the preference block in `rerank` non-empty. Both
 * are stored exactly as the form stores them, so seeded and real members are
 * indistinguishable to everything downstream — except `source`, which stays
 * "seed" so a synthetic answer is never mistaken for something a person said.
 */
async function seedPreferences(
  personId: string,
  formats: MeetingFormat[],
  wants: string[],
): Promise<void> {
  const rows = [
    ...formats.map((value) => ({ kind: "format", value })),
    ...wants.slice(0, 3).map((value) => ({ kind: "wants", value: value.trim() })),
  ]
    .filter((r) => r.value)
    .map((r) => ({
      person_id: personId,
      kind: r.kind,
      value: r.value,
      source: "seed",
      confidence: 1,
      active: true,
    }));

  if (rows.length === 0) return;
  const { error } = await supabase
    .from("person_preferences")
    .upsert(rows, { onConflict: "person_id,kind,value" });
  // Not fatal: a seeded person with no preferences still matches on embeddings.
  if (error) console.warn(`[seed] preference write failed for ${personId}: ${error.message}`);
}

async function main() {
  if (RESET) {
    // Scoped to the synthetic cohort. An unscoped delete here wipes REAL members
    // too, cascading through introductions/conversations/relationships — i.e. it
    // silently destroys the people you are testing with. Matches are cleared for
    // synthetic pairs only, via the people rows they reference.
    const { data: synthetic, error: sErr } = await supabase
      .from("people")
      .select("id")
      .eq("is_synthetic", true);
    if (sErr) throw new Error(sErr.message);
    const ids = (synthetic ?? []).map((r) => r.id);

    if (ids.length) {
      await supabase.from("matches").delete().or(
        `person_a_id.in.(${ids.join(",")}),person_b_id.in.(${ids.join(",")})`,
      );
      await supabase.from("people").delete().in("id", ids);
    }
    console.log(`[seed] --reset removed ${ids.length} synthetic people (real members untouched)`);
  }

  const briefs = buildDiversityBriefs(SEED_COUNT, BATCH_SIZE);
  const peopleIds: string[] = [];
  let inserted = 0;

  for (const brief of briefs) {
    const profiles = await generateBatch(brief.text, brief.count);

    for (const p of profiles) {
      // Assigned here rather than generated: both are compared between two people
      // at scheduling time, so they have to come from a shared vocabulary.
      const city = CITIES[inserted % CITIES.length];
      const formats = FORMAT_SETS[inserted % FORMAT_SETS.length];

      const [embeddingOffering, embeddingLookingFor, embeddingTags] = await Promise.all([
        embed(`${p.headline}. Offers: ${p.offering}. Relevant background: ${p.bio}`),
        embed(`Looking for: ${p.looking_for}. Context: ${p.bio}`),
        embed(`${p.industry}. ${p.career_stage}. Tags: ${p.tags.join(", ")}. Location: ${city}.`),
      ]);

      const { data, error } = await supabase
        .from("people")
        .insert({
          name: p.name,
          headline: p.headline,
          bio: p.bio,
          offering: p.offering,
          looking_for: p.looking_for,
          tags: p.tags,
          industry: p.industry,
          career_stage: p.career_stage,
          location: city,
          // Display only. The list in `formats` is the part that drives behaviour.
          meeting_format: formats[0],
          ask_must_haves: p.ask_must_haves,
          ask_nice_to_haves: p.ask_nice_to_haves,
          // Contact + scheduling fields (migration 0007).
          email: inserted === 0 && TEST_EMAIL ? TEST_EMAIL : emailFor(p.name, inserted),
          timezone: TIMEZONES[inserted % TIMEZONES.length],
          intro_cadence: CADENCES[inserted % CADENCES.length],
          // Must be explicit. The column defaults to false (migration 0016), so
          // omitting it lands seeded personas in the REAL cohort — where the daily
          // cron (?synthetic=false) would pick them up and email @example.com
          // addresses, and where real members could be matched against them.
          is_synthetic: true,
          embedding_offering: embeddingOffering,
          embedding_looking_for: embeddingLookingFor,
          embedding_tags: embeddingTags,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      if (data?.id) {
        peopleIds.push(data.id);
        await seedPreferences(data.id, formats, p.ask_must_haves ?? []);
      }
      inserted++;
    }
    console.log(`Inserted batch of ${profiles.length} (${inserted}/${SEED_COUNT}) — ${brief.text}`);
  }

  console.log(`Done. Seeded ${inserted} people.`);

  await seedGraph(peopleIds);
}

// Generate a synthetic relationship graph so proximity-over-time (and the
// decay-proximity cron + /me connections list) are demonstrable out of the box:
// relationships with varied strength and last-interaction dates, an interaction
// timeline, and a handful of introductions in different lifecycle states.
async function seedGraph(peopleIds: string[]) {
  if (peopleIds.length < 2) return;

  const REL_STATUSES = ["introduced", "connected", "met", "dormant"];
  const INT_TYPES = ["intro_sent", "opted_in", "meeting_scheduled", "message"] as const;
  const INTRO_STATES = [
    "proposed",
    "a_invited",
    "a_opted_in",
    "both_opted_in",
    "scheduling",
    "scheduled",
    "declined",
  ];
  const day = 86_400_000;
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];

  const seen = new Set<string>();
  let rels = 0;
  let ints = 0;
  let intros = 0;

  const target = Math.min(peopleIds.length * 2, 120);
  for (let i = 0; i < target; i++) {
    const a = pick(peopleIds);
    const b = pick(peopleIds);
    if (a === b) continue;
    const key = [a, b].sort().join(":");
    if (seen.has(key)) continue;
    seen.add(key);

    const daysAgoFirst = 30 + Math.floor(Math.random() * 300);
    const daysAgoLast = Math.floor(Math.random() * daysAgoFirst);
    const strength = Math.round((0.1 + Math.random() * 0.85) * 1000) / 1000;

    const { data: rel, error } = await supabase
      .from("relationships")
      .insert({
        person_a_id: a,
        person_b_id: b,
        status: pick(REL_STATUSES),
        source: "dawn_intro",
        strength,
        first_connected_at: new Date(Date.now() - daysAgoFirst * day).toISOString(),
        last_interaction_at: new Date(Date.now() - daysAgoLast * day).toISOString(),
      })
      .select("id")
      .single();
    if (error || !rel) continue;
    rels++;

    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const occ = new Date(Date.now() - Math.floor(Math.random() * daysAgoFirst) * day).toISOString();
      const { error: iErr } = await supabase.from("interactions").insert({
        relationship_id: rel.id,
        person_id: a,
        counterparty_id: b,
        type: pick(INT_TYPES),
        weight: Math.round(Math.random() * 0.4 * 1000) / 1000,
        occurred_at: occ,
      });
      if (!iErr) ints++;
    }
  }

  const introTarget = Math.min(peopleIds.length, 12);
  for (let i = 0; i < introTarget; i++) {
    const a = pick(peopleIds);
    const b = pick(peopleIds);
    if (a === b) continue;
    const state = pick(INTRO_STATES);
    const advanced = ["a_opted_in", "both_opted_in", "scheduling", "scheduled"].includes(state);
    const { error } = await supabase.from("introductions").insert({
      person_a_id: a,
      person_b_id: b,
      state,
      a_response: advanced ? "yes" : "pending",
      b_response: ["both_opted_in", "scheduling", "scheduled"].includes(state) ? "yes" : "pending",
      rationale: "Synthetic seed introduction.",
    });
    if (!error) intros++;
  }

  console.log(`Seeded graph: ${rels} relationships, ${ints} interactions, ${intros} introductions.`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : JSON.stringify(e);
  console.error("\nSeed failed:", msg);
  if (/column .* does not exist|schema cache|Could not find/i.test(msg)) {
    console.error("→ Looks like migrations 0007–0011 haven't been applied yet. Apply them first, then re-run.");
  }
  process.exit(1);
});
