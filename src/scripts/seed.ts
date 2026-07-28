import { supabase } from "../lib/supabase";
import { embed } from "../lib/openai";
import { anthropic, textOf } from "../lib/anthropic";
import type { GeneratedProfile } from "../lib/types";

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

const MEETING_FORMATS = ["async", "call", "in_person"];

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
          location: { type: "string" },
          meeting_format: { type: "string", enum: MEETING_FORMATS },
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
          "location",
          "meeting_format",
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
        content: `Generate ${count} realistic, varied synthetic professional networking profiles for a startup-ecosystem intro platform. Diversity brief for this batch: ${brief}. Each profile needs a short "offering" (what they can give another person: expertise, intros, capital, time, mentorship) and a distinct "looking_for" (their current ask/intent) that is NOT just the inverse of offering. Also include: "industry" (a specific industry/vertical, not necessarily the batch's lean), "career_stage" (their actual career stage), "location" (a plausible city or "Remote"), "meeting_format" (one of ${MEETING_FORMATS.join(", ")}), "ask_must_haves" (1-3 short phrases naming the specific, non-negotiable parts of their ask — decomposed from "looking_for", not restating it wholesale), and "ask_nice_to_haves" (0-2 short phrases for bonus-but-not-required parts of their ask). Vary sentence structure and vocabulary across profiles — avoid template-y repetition.`,
      },
    ],
  });
  const parsed = JSON.parse(textOf(resp));
  return parsed.profiles;
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
      const [embeddingOffering, embeddingLookingFor, embeddingTags] = await Promise.all([
        embed(`${p.headline}. Offers: ${p.offering}. Relevant background: ${p.bio}`),
        embed(`Looking for: ${p.looking_for}. Context: ${p.bio}`),
        embed(`${p.industry}. ${p.career_stage}. Tags: ${p.tags.join(", ")}. Location: ${p.location}.`),
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
          location: p.location,
          meeting_format: p.meeting_format,
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
      if (data?.id) peopleIds.push(data.id);
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
