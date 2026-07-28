// Generate the pilot's demo personas: fictional counterparts written against what
// the real members actually asked for, all delivering to one inbox the operator
// controls.
//
// Run this AFTER the teammates have onboarded, not before. The whole test rests on
// whether a warm introduction feels valuable, and that judgement is made on the
// strength of the match — matching is embedding-based on each member's own
// `looking_for` and `goals`, so personas invented before anyone said what they
// wanted produce plausible-looking intros to people no one would agree to meet.
// Generating from live member rows is what makes the intros worth replying to.
//
//   npx tsx src/scripts/demo-personas.ts            # add personas for current members
//   npx tsx src/scripts/demo-personas.ts --reset     # remove existing ones first
//
// Env:
//   DEMO_PERSONA_INBOX   Operator address the personas deliver to (e.g. pk@interplay.vc).
//                        Each persona gets a plus-addressed variant of it, because
//                        `people.email` is unique — see baseAddress() in triage.ts.
//   PERSONAS_PER_MEMBER  Default 6. With 5 teammates that's 30 possible partners,
//                        which is ~7 days of introductions at four a day.

import { supabase } from "../lib/supabase";
import { embed } from "../lib/openai";
import { anthropic } from "../lib/anthropic";

const PER_MEMBER = Number(process.env.PERSONAS_PER_MEMBER ?? 6);
const RESET = process.argv.includes("--reset");
const INBOX = process.env.DEMO_PERSONA_INBOX?.trim();

const TIMEZONES = ["America/New_York", "America/Los_Angeles", "Europe/London", "America/Chicago"];

interface MemberRow {
  id: string;
  name: string;
  headline: string | null;
  bio: string | null;
  offering: string | null;
  looking_for: string | null;
  goals: string[] | null;
  background: string[] | null;
  tags: string[] | null;
}

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
  answers_which_goal: string;
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
          answers_which_goal: { type: "string" },
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
          "answers_which_goal",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["personas"],
  additionalProperties: false,
} as const;

/**
 * Plus-addressed variant of the operator's mailbox: pk@interplay.vc → pk+ava.chen@interplay.vc.
 *
 * Every persona needs its OWN address (people.email is unique per 0016) while all of
 * them have to land in one inbox the operator reads. Inbound triage strips the tag
 * back off and uses the thread to work out which persona a reply speaks for.
 */
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

function describeMember(m: MemberRow): string {
  const lines = [
    `Name: ${m.name}`,
    m.headline ? `Headline: ${m.headline}` : null,
    m.bio ? `About: ${m.bio}` : null,
    m.offering ? `What they can offer others: ${m.offering}` : null,
    m.looking_for ? `What they are looking for: ${m.looking_for}` : null,
    m.goals?.length ? `Stated goals:\n- ${m.goals.join("\n- ")}` : null,
    m.background?.length ? `Background: ${m.background.join("; ")}` : null,
    m.tags?.length ? `Tags: ${m.tags.join(", ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

async function generateFor(member: MemberRow, count: number): Promise<PersonaProfile[]> {
  const prompt =
    `Below is a real member of a private professional network. An agent named Dawn will ` +
    `email them warm introductions to other members over the next few days.\n\n` +
    `${describeMember(member)}\n\n` +
    `Invent ${count} fictional people who would each be a genuinely valuable introduction ` +
    `for this member — the kind of person they would actually reply "yes" to meeting.\n\n` +
    `Rules that decide whether this works:\n` +
    `- Each persona must plainly be able to help with a SPECIFIC thing this member said ` +
    `they want. Put that thing verbatim in "answers_which_goal".\n` +
    `- Cover different goals across the set, and vary seniority, company stage and angle. ` +
    `Do not produce ${count} versions of the same person.\n` +
    `- "offering" is what they can give this member. "looking_for" is their OWN separate ask ` +
    `— real people have their own agenda, and an introduction that runs both ways is more ` +
    `credible than a favour.\n` +
    `- Ordinary, plausible names and companies. No luminaries, no famous people, nothing ` +
    `that reads as a placeholder or a joke. These will be read as real by their recipient.\n` +
    `- "bio" is two or three sentences of concrete specifics (what they built, where, when) ` +
    `rather than adjectives.\n` +
    `- "goals" 2-3 items, "background" 2-4 items, "tags" 3-6 lowercase topic tags.\n` +
    `- "ask_must_haves" 1-3 short phrases naming the non-negotiable parts of their own ask; ` +
    `"ask_nice_to_haves" 0-2 bonus parts.`;

  // Streamed because of the large max_tokens: a non-streaming request at this size
  // risks an SDK HTTP timeout. Thinking is on by default on Opus 5 and shares the
  // same budget as the output, hence the headroom.
  const stream = anthropic.messages.stream({
    model: "claude-opus-5",
    max_tokens: 32000,
    output_config: { format: { type: "json_schema", schema: PERSONA_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  const resp = await stream.finalMessage();
  const text = resp.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`No text block generating personas for ${member.name} (${resp.stop_reason})`);
  }
  return (JSON.parse(text.text) as { personas: PersonaProfile[] }).personas;
}

/** Remove previously generated personas, and only those. */
async function reset() {
  const { data, error } = await supabase.from("people").select("id").eq("is_demo_persona", true);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((r) => r.id as string);
  if (!ids.length) {
    console.log("[demo-personas] --reset: none to remove");
    return;
  }

  // One delete is enough: every foreign key into `people` is ON DELETE CASCADE, so
  // matches, introductions, conversations, messages, relationships and preferences
  // for these rows go with them. Scoped to the flag — an unscoped delete here would
  // take the real members and their whole history with it.
  const { error: delErr } = await supabase.from("people").delete().in("id", ids);
  if (delErr) throw new Error(delErr.message);
  console.log(`[demo-personas] --reset removed ${ids.length} personas (members untouched)`);
}

async function main() {
  if (!INBOX) {
    throw new Error("Set DEMO_PERSONA_INBOX to the inbox you want every persona's mail to land in.");
  }
  if (!process.env.OPENAI_API_KEY) {
    // Without embeddings a persona is invisible to matching: fetchCandidates works
    // off the vector RPCs, so an unembedded row is never a candidate for anyone.
    throw new Error("OPENAI_API_KEY is required — personas without embeddings can never be matched.");
  }

  if (RESET) await reset();

  // Real members only: is_synthetic = false excludes the seeded @example.com
  // fixtures, is_demo_persona = false excludes personas from a previous run.
  const { data: memberData, error } = await supabase
    .from("people")
    .select("id, name, headline, bio, offering, looking_for, goals, background, tags")
    .eq("is_synthetic", false)
    .eq("is_demo_persona", false)
    .eq("paused", false);
  if (error) throw new Error(error.message);
  const members = (memberData ?? []) as MemberRow[];

  const withAsks = members.filter((m) => m.looking_for || m.goals?.length);
  if (!withAsks.length) {
    console.log(
      "[demo-personas] No onboarded members with a stated ask yet. Have the team go " +
        "through /join first — personas are written against what they actually want.",
    );
    return;
  }
  const skipped = members.length - withAsks.length;
  if (skipped > 0) {
    console.log(`[demo-personas] Skipping ${skipped} member(s) with no stated ask.`);
  }

  let index = 0;
  let inserted = 0;
  for (const member of withAsks) {
    const personas = await generateFor(member, PER_MEMBER);
    console.log(`\n[demo-personas] ${member.name} — ${personas.length} counterparts:`);

    for (const p of personas) {
      const [embeddingOffering, embeddingLookingFor, embeddingTags] = await Promise.all([
        embed(`${p.headline}. Offers: ${p.offering}. Relevant background: ${p.bio} ${p.background.join(". ")}`),
        embed(`Looking for: ${p.looking_for}. Goals: ${p.goals.join(". ")}. Context: ${p.bio}`),
        embed(`${p.industry}. ${p.career_stage}. Tags: ${p.tags.join(", ")}. Location: ${p.location}.`),
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
        tags: p.tags,
        industry: p.industry,
        career_stage: p.career_stage,
        location: p.location,
        meeting_format: p.meeting_format,
        ask_must_haves: p.ask_must_haves,
        ask_nice_to_haves: p.ask_nice_to_haves,
        email,
        timezone: TIMEZONES[index % TIMEZONES.length],
        // Never read: run-matches excludes personas as subjects, so no cadence
        // window is ever consulted for them. Set to the least eager value anyway,
        // so a future change to that filter fails quietly rather than loudly.
        intro_cadence: "monthly",
        // The pair that defines the demo cohort (0018): real cohort, so teammates
        // can be matched with them; flagged, so Dawn never acts on their behalf.
        is_synthetic: false,
        is_demo_persona: true,
        paused: false,
        embedding_offering: embeddingOffering,
        embedding_looking_for: embeddingLookingFor,
        embedding_tags: embeddingTags,
      });
      if (insErr) throw new Error(`Insert failed for ${p.name} <${email}>: ${insErr.message}`);

      console.log(`  ${p.name} <${email}> — for: ${p.answers_which_goal}`);
      index++;
      inserted++;
    }
  }

  console.log(
    `\n[demo-personas] Done. ${inserted} personas across ${withAsks.length} member(s), ` +
      `all delivering to ${INBOX}.\n` +
      `Read the list above before starting the run: these are the introductions your ` +
      `teammates will be offered, and a persona that doesn't ring true is a "no".`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
