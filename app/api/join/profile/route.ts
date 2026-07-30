import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../../../../src/lib/anthropic";
import {
  cadenceQuestion,
  formatQuestion,
  type OnboardingOption,
  type OnboardingQuestion,
  type PreferenceKind,
} from "../../../../lib/onboarding";

export const runtime = "nodejs";

/**
 * Builds a member's profile and their onboarding questions in one call.
 *
 * This replaced a multi-turn chat. The chat asked one question per turn and had no
 * enforceable limit — a prompt saying "two or three exchanges is plenty" is a
 * suggestion, and the model talked past it, so joining became an interview. Doing
 * it in a single pass means the member reads their questions all at once, already
 * answered with a sensible default, and the number of them is a constant rather
 * than whatever the model felt like asking.
 *
 * The questions are generated rather than fixed because generic options ("founders",
 * "engineers") produce generic preferences, and `person_preferences.value` is
 * rendered straight into the matching prompt. Options that name this member's
 * actual domain are what make the first intro land.
 */

/**
 * The generated question groups, in the order they're shown.
 *
 * `format` is deliberately not here. Its answers are compared between two people at
 * scheduling time to decide what Dawn proposes, so the values have to be a fixed
 * enum — see `formatQuestion`. Everything in this list is prose the model writes
 * for this member, read back only as context in the matching prompt.
 */
const GENERATED_GROUPS: { id: string; kind: PreferenceKind }[] = [
  { id: "wants", kind: "wants" },
  { id: "avoids", kind: "avoids" },
  { id: "intro_style", kind: "intro_style" },
];

const SYSTEM_PROMPT = `You are Dawn — a warm, sharp career agent onboarding a new member.

You get exactly one pass. From the résumé, LinkedIn export, or description you're given, do two things at once: write their profile, and write the three questions the form will ask them. Then call build_onboarding. Never ask a follow-up — infer whatever is missing.

WRITING THE PROFILE
Draw everything from what you were given. Their goals are the most important field and the most often unstated: infer them from trajectory — what someone at this point in this kind of career is usually reaching for next. Write in their voice, not a recruiter's.

WRITING THE QUESTIONS
Each question needs 5-6 options, and they must be specific to this person's world. Name the actual industries, functions, company stages, and problems that surround someone with this background. "People in fintech who've scaled a payments team past 50" is useful; "interesting people" is not. A member should be able to tell these options were written for them and not for everyone.

Nothing you write gets pre-answered for them — every option arrives unticked and the member chooses. So the options carry the whole question: make each one a real, distinct position someone could hold, and don't pad the list with options nobody would pick. If you have a view on what fits them, put it in \`helper\` as one line of prose rather than assuming it.

Each option's \`value\` is stored and read later by the matching engine, so write it as a self-contained noun phrase that makes sense with no surrounding context ("operators who have run a support org through hypergrowth"). The \`label\` is what the member reads on a chip: same idea, fewer words.

The three questions you write, in order:
1. wants — who they should be introduced to.
2. avoids — who is not a fit right now. Give real, non-insulting outs: wrong stage, wrong function, anything that would waste both people's time. Most people have fewer exclusions than inclusions, so this list can be shorter.
3. intro_style — how they want to show up for others, including whether they're open to helping people earlier in their career. Make "happy to mentor people a few years behind me" a real option alongside "I'd rather meet peers" and "senior people who've done this before".

Two questions are already written and you don't author their options — you write the one line of context that sits under each:
- format_note — under "how would you want a first conversation to happen?". Their answer here is matched against the other person's to decide what Dawn actually proposes, so nudge them to tick everything they'd genuinely accept rather than only their favourite. If their location or travel makes in-person plausible or implausible, say so.
- cadence_note — under the frequency question. What should someone with their schedule weigh? Name a frequency if you have a view, but write it as advice they can disagree with.`;

const BUILD_TOOL: Anthropic.Messages.Tool = {
  name: "build_onboarding",
  description:
    "Emit the member's profile plus the personalized questions their onboarding form should ask.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The member's name." },
      headline: { type: "string", description: "A crisp one-line headline for who they are." },
      summary: { type: "string", description: "2-3 sentence narrative summary of the member." },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "Their concrete career goals / what they want next. 2-4 items.",
      },
      background: {
        type: "array",
        items: { type: "string" },
        description: "Key points of their career background and experience. 3-5 items.",
      },
      offering: { type: "string", description: "What they can offer others in the network." },
      looking_for: { type: "string", description: "What they are looking for from the network." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3-6 short topical tags (e.g. fintech, product, seed-stage).",
      },
      questions: {
        type: "array",
        description:
          "Exactly three question groups, in this order: wants, avoids, intro_style.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              enum: ["wants", "avoids", "intro_style"],
            },
            title: { type: "string", description: "The question, written for this member." },
            helper: { type: "string", description: "One short line of context." },
            options: {
              type: "array",
              description: "5-6 options. None are preselected — the member picks.",
              items: {
                type: "object",
                properties: {
                  value: {
                    type: "string",
                    description:
                      "Self-contained noun phrase stored for the matching engine.",
                  },
                  label: { type: "string", description: "Short chip text for the member." },
                },
                required: ["value", "label"],
              },
            },
          },
          required: ["id", "title", "helper", "options"],
        },
      },
      format_note: {
        type: "string",
        description:
          "One line under the meeting-format question. Shown to the member; nudges them to tick everything they'd accept.",
      },
      cadence_note: {
        type: "string",
        description:
          "One line of advice on choosing a frequency, given their schedule. Shown under the question.",
      },
    },
    required: [
      "name",
      "headline",
      "summary",
      "goals",
      "background",
      "offering",
      "looking_for",
      "tags",
      "questions",
      "format_note",
      "cadence_note",
    ],
  },
};

interface RequestBody {
  /** What the member typed, when they don't have a LinkedIn export to hand. */
  text?: string;
  pdf?: { data: string; mediaType?: string };
}

/** The tool's `questions` entries, before normalization. */
interface RawQuestion {
  id?: unknown;
  title?: unknown;
  helper?: unknown;
  options?: unknown;
}

export async function POST(req: Request) {
  try {
    const { text, pdf } = (await req.json()) as RequestBody;

    if (!pdf?.data && !text?.trim()) {
      return NextResponse.json(
        { error: "Upload your LinkedIn export or describe your work" },
        { status: 400 },
      );
    }

    const content: Anthropic.Messages.ContentBlockParam[] = [];
    if (pdf?.data) {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: (pdf.mediaType as "application/pdf") ?? "application/pdf",
          data: pdf.data,
        },
      });
    }
    content.push({
      type: "text",
      text: text?.trim()
        ? text.trim()
        : "Here is my LinkedIn export. Build my profile and my onboarding questions.",
    });

    // Thinking is on: inferring someone's unstated goals from a résumé, then
    // writing options specific enough to name their actual domain, is the part
    // of this call worth reasoning about.
    //
    // Which is what forces the two settings around it. Thinking spends from the
    // same max_tokens as the response, so the budget has to cover both — the
    // original 8k ran out mid-tool-call and truncated `questions` while leaving
    // the profile fields (emitted first) intact: a form that asked only about
    // frequency. And a budget this size needs streaming, or the request risks an
    // SDK HTTP timeout before it finishes.
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-5",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      tools: [BUILD_TOOL],
      // One pass, no conversation — the tool call *is* the response.
      tool_choice: { type: "tool", name: "build_onboarding" },
      messages: [{ role: "user", content }],
    });
    const resp = await stream.finalMessage();

    if (resp.stop_reason === "max_tokens") {
      console.error("[join/profile] truncated at max_tokens", resp.usage);
      return NextResponse.json(
        { error: "Couldn't build your questions — try again" },
        { status: 502 },
      );
    }

    const toolUse = resp.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === "build_onboarding",
    );

    if (!toolUse) {
      return NextResponse.json(
        { error: "Couldn't read that — try describing your work instead" },
        { status: 502 },
      );
    }

    const built = toolUse.input as Record<string, unknown>;

    const profile = {
      name: str(built.name) || "there",
      headline: str(built.headline),
      summary: str(built.summary),
      goals: strArray(built.goals),
      background: strArray(built.background),
      offering: str(built.offering),
      looking_for: str(built.looking_for),
      tags: strArray(built.tags),
    };

    // `offering` and `looking_for` are required by POST /api/people and are what
    // the match embeddings are built from — a blank one would save a member who
    // can never be matched, so fail here instead.
    if (!profile.offering || !profile.looking_for) {
      return NextResponse.json(
        { error: "Couldn't build a full profile from that — try adding more detail" },
        { status: 502 },
      );
    }

    const questions = normalizeQuestions(built.questions);

    // Dropping one malformed group is a graceful degradation; dropping all four
    // leaves a form that asks only about frequency, which isn't worth showing.
    if (questions.length === 0) {
      console.error("[join/profile] no usable questions", built.questions);
      return NextResponse.json(
        { error: "Couldn't build your questions — try again" },
        { status: 502 },
      );
    }

    // The two fixed-enum questions go last: their answers are read by machinery
    // (scheduling, the intro cron) rather than by the matching prompt.
    questions.push(formatQuestion(str(built.format_note)));
    questions.push(cadenceQuestion(str(built.cadence_note)));

    return NextResponse.json({ profile, questions });
  } catch (err) {
    console.error("[join/profile] error", err);
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Keep only the four expected groups, in our order, with usable options.
 *
 * The model is forced into the tool but not into a valid `id`, and a group whose
 * options all arrived preselected would defeat the point of asking. Dropping a
 * malformed group is better than rendering an empty question.
 */
function normalizeQuestions(raw: unknown): OnboardingQuestion[] {
  const byId = new Map<string, RawQuestion>();
  if (Array.isArray(raw)) {
    for (const entry of raw as RawQuestion[]) {
      if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
    }
  }

  const questions: OnboardingQuestion[] = [];
  for (const group of GENERATED_GROUPS) {
    const entry = byId.get(group.id);
    if (!entry) continue;
    const options = normalizeOptions(entry.options);
    if (options.length < 2) continue;
    questions.push({
      id: group.id,
      kind: group.kind,
      title: str(entry.title) || "What should Dawn know?",
      helper: str(entry.helper),
      select: "multi",
      options,
    });
  }
  return questions;
}

function normalizeOptions(raw: unknown): OnboardingOption[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const options: OnboardingOption[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const value = str(entry?.value);
    if (!value) continue;
    // person_preferences is unique on (person_id, kind, value); a duplicate here
    // would make the upsert drop one silently.
    const dedupeKey = value.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    options.push({ value, label: str(entry?.label) || value });
  }

  return options;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}
