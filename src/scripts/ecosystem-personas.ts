// Seed a broad NYC / tech-ecosystem persona pool.
//
// This is the sibling of demo-personas.ts and answers a different question. That
// script writes counterparts against what a specific member ASKED FOR, which is the
// right thing for a scripted pilot but produces a pool that only makes sense for the
// members who existed when it ran. A colleague who joins tomorrow gets matched
// against personas invented for somebody else's goals — or, if their ask is far
// enough away, `run-matches` returns "no candidates" and they sit through the pilot
// receiving nothing.
//
// A standing pool fixes that: fifty plausible people spread across the ecosystem, so
// an arbitrary new member has something credible to be matched with on day one,
// before anyone has run a goal-directed generation pass. Use both — this for
// breadth, demo-personas.ts for depth once you know who joined.
//
//   npx tsx src/scripts/ecosystem-personas.ts             # add the pool
//   npx tsx src/scripts/ecosystem-personas.ts --reset      # remove THIS pool first
//   PER_SEGMENT=3 npx tsx src/scripts/ecosystem-personas.ts
//
// The pool is generated segment by segment rather than in one call. Asked for fifty
// people at once a model drifts to the mode of its training data — variations on the
// same seed-stage founder — and a pool that all looks alike defeats the point of
// having one. Ten disjoint briefs force the spread.
//
// Env:
//   DEMO_PERSONA_INBOX   Operator address every persona delivers to. Each gets a
//                        plus-addressed variant (people.email is unique).
//   OPENAI_API_KEY       Required: an unembedded persona is invisible to matching.
//   PER_SEGMENT          Personas per segment. Default 5 → 50 total.

import pLimit from "p-limit";
import { supabase } from "../lib/supabase";
import { embed } from "../lib/openai";
import { anthropic } from "../lib/anthropic";

const PER_SEGMENT = Number(process.env.PER_SEGMENT ?? 5);
const RESET = process.argv.includes("--reset");
const INBOX = process.env.DEMO_PERSONA_INBOX?.trim();

/**
 * Marker tag carried by every persona this script creates.
 *
 * `demo-personas.ts --reset` deletes every row with `is_demo_persona = true`, which
 * would take this pool with it. There is no column to tell the two apart, so the tag
 * is the discriminator, and it is what `--reset` here matches on — so the two pools
 * can be regenerated independently instead of one clobbering the other.
 */
const POOL_TAG = "nyc-ecosystem";

// NYC-weighted, with the spillover that actually exists in these networks.
const TIMEZONES = ["America/New_York", "America/New_York", "America/New_York", "America/Los_Angeles"];

interface Segment {
  key: string;
  brief: string;
}

// Disjoint slices of the ecosystem. Between them these cover both sides of most
// introductions worth making: people with capital, people with distribution, people
// with craft, and the connective tissue that makes a scene rather than a list.
const SEGMENTS: Segment[] = [
  {
    key: "early-founders",
    brief:
      "Pre-seed and seed founders, 1-15 people, based in NYC. Spread across AI tooling, " +
      "fintech, healthtech, vertical SaaS and devtools. Some technical, some commercial; " +
      "some first-time, some second-time.",
  },
  {
    key: "growth-founders",
    brief:
      "Founders and C-level execs at Series A through C companies in NYC, 30-300 people. " +
      "Past product-market fit and dealing with scaling problems: hiring, org design, " +
      "pricing changes, entering a second market, raising the next round.",
  },
  {
    key: "investors",
    brief:
      "The NYC capital side: angels writing $25-100k, pre-seed and seed fund GPs, one or " +
      "two Series A partners, a platform/talent partner at a fund, an LP-turned-angel, " +
      "and someone doing venture debt or revenue-based financing.",
  },
  {
    key: "eng-leaders",
    brief:
      "Engineering craft and leadership: staff and principal ICs, VPs of Engineering, " +
      "CTOs at 20-200 person companies, plus infrastructure, platform and security " +
      "specialists. Several ex-big-tech now at startups.",
  },
  {
    key: "product-design",
    brief:
      "Product and design: heads of product, principal PMs, design leads, a design-systems " +
      "specialist, a user-research lead, and a product person who moved into founding.",
  },
  {
    key: "gtm",
    brief:
      "Go-to-market: first-sales-hire types, VPs of Sales, enterprise AEs selling into " +
      "finance and healthcare, growth marketers, a partnerships lead, a RevOps person, " +
      "and a founder-led-sales coach.",
  },
  {
    key: "data-ai",
    brief:
      "Data and AI practitioners: ML engineers, applied scientists, a research engineer " +
      "who left a lab for a startup, data platform leads, an evals/quality specialist, " +
      "and someone doing AI policy or safety work.",
  },
  {
    key: "fintech-crypto",
    brief:
      "NYC's financial strength: fintech operators (payments, lending, treasury, " +
      "compliance), a bank innovation lead, quant/trading people who moved to startups, " +
      "and one or two crypto infrastructure builders. Regulatory literacy is a theme.",
  },
  {
    key: "consumer-commerce",
    brief:
      "Consumer, marketplace, commerce and media: DTC and marketplace operators, a " +
      "creator-economy builder, someone in digital health consumer, a media/newsletter " +
      "operator, and a brand/community marketer.",
  },
  {
    key: "enablers",
    brief:
      "The connective tissue: startup recruiters and talent partners, a startup lawyer, " +
      "a fractional CFO, an accelerator/program director, a founder-community organiser, " +
      "and an executive coach who works with founders.",
  },
];

interface PersonaProfile {
  name: string;
  headline: string;
  bio: string;
  offering: string;
  looking_for: string;
  goals: string[];
  background: string[];
  tags: string[];
  industry: string;
  career_stage: string;
  location: string;
  meeting_format: string;
  ask_must_haves: string[];
  ask_nice_to_haves: string[];
}

const PERSONA_SCHEMA = {
  type: "object",
  properties: {
    personas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          headline: { type: "string" },
          bio: { type: "string" },
          offering: { type: "string" },
          looking_for: { type: "string" },
          goals: { type: "array", items: { type: "string" } },
          background: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
          industry: { type: "string" },
          career_stage: { type: "string" },
          location: { type: "string" },
          meeting_format: { type: "string", enum: ["async", "call", "in_person"] },
          ask_must_haves: { type: "array", items: { type: "string" } },
          ask_nice_to_haves: { type: "array", items: { type: "string" } },
        },
        required: [
          "name",
          "headline",
          "bio",
          "offering",
          "looking_for",
          "goals",
          "background",
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
  required: ["personas"],
  additionalProperties: false,
} as const;

function personaEmail(name: string, index: number): string {
  if (!INBOX || !INBOX.includes("@")) {
    throw new Error("DEMO_PERSONA_INBOX must be a real address you can read, e.g. pk@interplay.vc");
  }
  const at = INBOX.lastIndexOf("@");
  const local = INBOX.slice(0, at).split("+")[0];
  const domain = INBOX.slice(at);
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z]+/g, ".")
      .replace(/^\.|\.$/g, "") || `persona${index}`;
  return `${local}+${slug}${index}${domain}`;
}

async function generateSegment(
  segment: Segment,
  count: number,
  usedNames: string[],
): Promise<PersonaProfile[]> {
  // Without this the pool collapses onto a handful of names. Each segment is its own
  // completion, and independent calls reach for the same modal choices — the first
  // run produced six people called "Priya Raghunathan" and a "Marcus" in nine of ten
  // segments. Duplicate names in a network of strangers read as obviously fabricated,
  // so every prior name is passed forward as an explicit exclusion.
  const exclusions = usedNames.length
    ? `\nNames already used elsewhere in this network — do NOT reuse any of these, and ` +
      `do not reuse their FIRST names or SURNAMES either:\n${usedNames.join(", ")}\n`
    : "";

  const prompt =
    `Invent ${count} fictional people who would plausibly belong to a private ` +
    `professional network centred on the New York City technology and startup ecosystem.\n\n` +
    `This batch must fit the following slice of that ecosystem:\n${segment.brief}\n` +
    exclusions +
    `\n`  +
    `An agent named Dawn will offer these people to real members as warm introductions, ` +
    `and the member decides yes or no from the description alone. Rules that decide ` +
    `whether this works:\n` +
    `- Ordinary, plausible names and companies. No famous people, no luminaries, nothing ` +
    `that reads as a placeholder, a pun or a joke. Vary ethnicity and gender the way an ` +
    `actual NYC network does.\n` +
    `- Write every name in the Latin alphabet as it would appear in an email signature. ` +
    `Accents are fine; do not emit characters from other scripts.\n` +
    `- Draw first names widely. Do not give two people in this batch the same first name.\n` +
    `- Invent company names that sound like real startups, not like examples.\n` +
    `- "bio" is two or three sentences of concrete specifics — what they built, where, ` +
    `roughly when, at what scale — rather than adjectives. "Led the team that took ` +
    `payments in-house at a 60-person lender" beats "experienced fintech leader".\n` +
    `- "offering" is what this person can concretely do for someone else. "looking_for" ` +
    `is their OWN separate ask. Both matter: introductions that run in both directions ` +
    `are the ones people say yes to.\n` +
    `- Make the asks specific and answerable by another person in a tech network. Avoid ` +
    `vague asks like "networking" or "meeting interesting people".\n` +
    `- Vary seniority, company stage, and how long they have been in New York. Include ` +
    `some people who are not obviously impressive on paper but are useful to know.\n` +
    `- "location" should mostly be New York City or a specific NYC neighbourhood/borough, ` +
    `with a small number in the wider metro area or commuting from elsewhere.\n` +
    `- "goals" 2-3 items, "background" 2-4 items, "tags" 3-6 lowercase topic tags.\n` +
    `- "ask_must_haves" 1-3 short phrases naming the non-negotiable parts of their ask; ` +
    `"ask_nice_to_haves" 0-2 bonus parts.\n` +
    `- Do not produce ${count} versions of the same person. Different angles, different ` +
    `problems, different stages.`;

  const stream = anthropic.messages.stream({
    model: "claude-opus-5",
    max_tokens: 32000,
    output_config: { format: { type: "json_schema", schema: PERSONA_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  const resp = await stream.finalMessage();
  const text = resp.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`No text block for segment ${segment.key} (${resp.stop_reason})`);
  }
  return (JSON.parse(text.text) as { personas: PersonaProfile[] }).personas;
}

/** Remove only the personas this script created, matched on POOL_TAG. */
async function reset() {
  const { data, error } = await supabase
    .from("people")
    .select("id")
    .eq("is_demo_persona", true)
    .contains("tags", [POOL_TAG]);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((r) => r.id as string);
  if (!ids.length) {
    console.log("[ecosystem] --reset: none to remove");
    return;
  }
  // Every foreign key into `people` is ON DELETE CASCADE, so their matches,
  // introductions, conversations and messages go with them.
  const { error: delErr } = await supabase.from("people").delete().in("id", ids);
  if (delErr) throw new Error(delErr.message);
  console.log(`[ecosystem] --reset removed ${ids.length} pooled personas`);
}

/**
 * Index offset that clears every persona email already in the table.
 *
 * `people.email` is unique and the address is derived from name + index, so starting
 * at zero collides with demo-personas.ts's set on any repeated name. Counting the
 * existing rows and starting past them keeps the two generators from fighting.
 */
async function startIndex(): Promise<number> {
  const { count, error } = await supabase
    .from("people")
    .select("*", { count: "exact", head: true })
    .eq("is_demo_persona", true);
  if (error) throw new Error(error.message);
  return (count ?? 0) + 100;
}

async function main() {
  if (!INBOX) {
    throw new Error("Set DEMO_PERSONA_INBOX to the inbox you want every persona's mail to land in.");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required — personas without embeddings can never be matched.");
  }

  if (RESET) await reset();

  const target = SEGMENTS.length * PER_SEGMENT;
  console.log(
    `[ecosystem] Generating ${target} personas across ${SEGMENTS.length} segments, ` +
      `all delivering to ${INBOX}.\n`,
  );

  // Sequential on purpose, despite the segments being logically independent. Each
  // call needs the names every earlier call chose so it can avoid them, and that
  // ordering constraint is worth more than the wall-clock saved by fanning out —
  // a pool with six identical names is not a pool.
  const batches: { segment: Segment; personas: PersonaProfile[] }[] = [];
  const usedNames: string[] = [];
  for (const segment of SEGMENTS) {
    const personas = await generateSegment(segment, PER_SEGMENT, usedNames);
    usedNames.push(...personas.map((p) => p.name));
    console.log(`[ecosystem] ${segment.key}: ${personas.length} generated`);
    batches.push({ segment, personas });
  }

  // Belt and braces: the exclusion list is an instruction, not a guarantee. Surface
  // any collision that slipped through rather than letting it reach a member's inbox.
  const seen = new Map<string, number>();
  for (const n of usedNames) seen.set(n, (seen.get(n) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, c]) => c > 1);
  if (dupes.length) {
    console.warn(
      `\n[ecosystem] WARNING duplicate names survived: ${dupes.map(([n, c]) => `${n} x${c}`).join(", ")}`,
    );
  }

  let index = await startIndex();
  let inserted = 0;
  const skipped: string[] = [];

  const embedLimit = pLimit(5);

  for (const { segment, personas } of batches) {
    console.log(`\n[ecosystem] ${segment.key}`);
    for (const p of personas) {
      // Tag every row so --reset can find exactly this pool later, and so the
      // segment is visible in the data rather than only in this script.
      const tags = [...new Set([...(p.tags ?? []), POOL_TAG, segment.key])];

      const [embeddingOffering, embeddingLookingFor, embeddingTags] = await Promise.all([
        embedLimit(() =>
          embed(
            `${p.headline}. Offers: ${p.offering}. Relevant background: ${p.bio} ${p.background.join(". ")}`,
          ),
        ),
        embedLimit(() =>
          embed(`Looking for: ${p.looking_for}. Goals: ${p.goals.join(". ")}. Context: ${p.bio}`),
        ),
        embedLimit(() =>
          embed(`${p.industry}. ${p.career_stage}. Tags: ${tags.join(", ")}. Location: ${p.location}.`),
        ),
      ]);

      const email = personaEmail(p.name, index);
      const { error: insErr } = await supabase.from("people").insert({
        name: p.name,
        headline: p.headline,
        bio: p.bio,
        offering: p.offering,
        looking_for: p.looking_for,
        goals: p.goals,
        background: p.background,
        tags,
        industry: p.industry,
        career_stage: p.career_stage,
        location: p.location,
        meeting_format: p.meeting_format,
        ask_must_haves: p.ask_must_haves,
        ask_nice_to_haves: p.ask_nice_to_haves,
        email,
        timezone: TIMEZONES[index % TIMEZONES.length],
        // Never consulted — run-matches excludes personas as subjects — but set to
        // the least eager value so a future change to that filter fails quietly.
        intro_cadence: "monthly",
        // Real cohort so members can be matched with them; flagged so Dawn never
        // opens an introduction on their behalf (0018).
        is_synthetic: false,
        is_demo_persona: true,
        paused: false,
        embedding_offering: embeddingOffering,
        embedding_looking_for: embeddingLookingFor,
        embedding_tags: embeddingTags,
      });

      index++;
      if (insErr) {
        // A duplicate name colliding on email shouldn't abandon the other 49.
        skipped.push(`${p.name} <${email}>: ${insErr.message}`);
        continue;
      }

      console.log(`  ${p.name} <${email}> — ${p.headline}`);
      inserted++;
    }
  }

  console.log(`\n[ecosystem] Inserted ${inserted}/${target} personas, all delivering to ${INBOX}.`);
  if (skipped.length) {
    console.log(`[ecosystem] Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  console.log(
    `\nRemove just this pool later with:  npx tsx src/scripts/ecosystem-personas.ts --reset`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
