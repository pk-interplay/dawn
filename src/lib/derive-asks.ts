import type { SupabaseClient } from "@supabase/supabase-js";

import { DERIVED_LIST_FIELDS } from "./profile-fields";
import { listLiveClaims, supersedeClaims, writeClaim } from "./claims";

/**
 * `looking_for` (prose) → `ask_must_haves` / `ask_nice_to_haves` (structured).
 *
 * ## Why this exists
 *
 * rerank.ts is told to "weigh must-haves heavily, nice-to-haves as a bonus", so the
 * decomposed ask is load-bearing in ranking and cannot simply be deleted. But the form
 * used to collect it by asking the member to take their own sentence apart — which is
 * the machine's job, and which meant three fields collecting one fact. This closes that
 * gap from the other end: the member writes the sentence, Dawn does the decomposition.
 *
 * ## Why it can't clobber the member
 *
 * Derived asks are written `inferred` at 0.7. If the member states their asks — in the
 * form, or by telling Dawn in chat — those land `self_reported` at 1.0, and this
 * function then does nothing at all for that entity, forever. Inference never overwrites
 * a statement; that rule is the whole reason profile-edit.ts writes at confidence 1.
 *
 * ## Why the evidence field matters
 *
 * Each derived claim carries the exact `looking_for` text it came from. That is what
 * makes this cheap to call on every save: if the stored evidence still matches the
 * current ask, the decomposition is already current and no model call happens. Editing
 * your bio therefore doesn't re-run Haiku over an ask that hasn't moved.
 */

const ASKS_SCHEMA = {
  type: "object",
  properties: {
    must_haves: { type: "array", items: { type: "string" } },
    nice_to_haves: { type: "array", items: { type: "string" } },
  },
  required: ["must_haves", "nice_to_haves"],
  additionalProperties: false,
} as const;

export interface DeriveAsksResult {
  /** Why nothing happened, when nothing happened — surfaced in logs, not to the user. */
  skipped: "member-stated" | "no-ask" | "unchanged" | null;
  must_haves: string[];
  nice_to_haves: string[];
}

export async function deriveAsks(
  client: SupabaseClient,
  entityId: string,
  input: { looking_for: string; goals: string[] },
): Promise<DeriveAsksResult> {
  const live = await listLiveClaims(client, entityId, DERIVED_LIST_FIELDS);

  // The member owns their asks the moment they say them. One self_reported claim on
  // either field hands both over — a half-derived, half-stated ask would be incoherent
  // to explain and worse to rank on.
  if (live.some((row) => row.method === "self_reported")) {
    return { skipped: "member-stated", must_haves: [], nice_to_haves: [] };
  }

  const lookingFor = input.looking_for.trim();
  if (!lookingFor) {
    // The ask was cleared, so the decomposition of it is no longer true of anybody.
    await supersedeClaims(client, live.map((row) => row.id));
    return { skipped: "no-ask", must_haves: [], nice_to_haves: [] };
  }

  const evidence = askEvidence(lookingFor, input.goals);
  if (live.length && live.every((row) => row.evidence === evidence)) {
    return { skipped: "unchanged", must_haves: [], nice_to_haves: [] };
  }

  const { anthropic, textOf } = await import("./anthropic");
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    output_config: { format: { type: "json_schema", schema: ASKS_SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          `A member of an introduction network wrote this about who they want to meet:\n\n` +
          `"${lookingFor}"\n\n` +
          (input.goals.length ? `They are currently working on:\n- ${input.goals.join("\n- ")}\n\n` : "") +
          `Decompose their ask into the specific parts an introduction would have to satisfy.\n` +
          `- "must_haves": 1-3 short phrases naming the NON-NEGOTIABLE parts. A candidate ` +
          `failing any one of these is not a match.\n` +
          `- "nice_to_haves": 0-2 short phrases for parts that would improve a match but ` +
          `would not rule one out.\n\n` +
          `Decompose only what they actually said — do not add requirements they did not ` +
          `state, and do not restate the whole sentence as a single must-have. If the ask ` +
          `is too vague to decompose ("I want to meet interesting people"), return empty ` +
          `arrays rather than inventing criteria.`,
      },
    ],
  });

  const parsed = JSON.parse(textOf(resp)) as { must_haves: unknown; nice_to_haves: unknown };
  const next: Record<string, string[]> = {
    ask_must_haves: cleanItems(parsed.must_haves, 3),
    ask_nice_to_haves: cleanItems(parsed.nice_to_haves, 2),
  };

  const observedAt = new Date().toISOString();
  for (const field of DERIVED_LIST_FIELDS) {
    const previous = live.filter((row) => row.attribute === field).map((row) => row.id);
    let successor: number | undefined;
    for (const value of next[field]) {
      const claim = await writeClaim(client, {
        subjectId: entityId,
        attribute: field,
        value,
        source: "derive-asks",
        method: "inferred",
        // Below anything self_reported, and below the 0.9 the people-table migration
        // used, so a real statement always wins the resolved view.
        confidence: 0.7,
        observedAt,
        evidence,
      });
      successor ??= claim.id;
    }
    await supersedeClaims(client, previous, successor);
  }

  return {
    skipped: null,
    must_haves: next.ask_must_haves,
    nice_to_haves: next.ask_nice_to_haves,
  };
}

/** The exact input a decomposition came from, so a later save can tell if it's stale. */
function askEvidence(lookingFor: string, goals: string[]): string {
  return goals.length ? `${lookingFor}\n\ngoals: ${goals.join(" | ")}` : lookingFor;
}

function cleanItems(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || item.length > 280 || seen.has(item.toLowerCase())) return false;
      seen.add(item.toLowerCase());
      return true;
    })
    .slice(0, max);
}
