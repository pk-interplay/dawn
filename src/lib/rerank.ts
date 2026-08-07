import type { Candidate, Person } from "./types";

const SHORTLIST_MIN = 3;
const SHORTLIST_MAX = 5;

export const MATCH_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_id: { type: "string" },
          name: { type: "string" },
          score: { type: "number" },
          direction: { type: "string", enum: ["a_offers_b_wants", "b_offers_a_wants", "mutual"] },
          rationale: { type: "string" },
        },
        required: ["candidate_id", "name", "score", "direction", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
} as const;

export interface RawMatch {
  candidate_id: string;
  name: string;
  score: number;
  direction: Candidate["surfaced_via"];
  rationale: string;
}

export interface CalibrationExample {
  other_name: string;
  status: string;
  rationale: string;
}

/** A durable belief about this person, from `person_preferences`. */
export interface PreferenceExample {
  kind: string;
  value: string;
  source: string;
  confidence: number;
}

/** Something this person actually said in an email to Dawn. */
export interface HistoryExample {
  when: string;
  purpose: string;
  said: string;
}

export async function rerank(
  person: Person,
  candidates: Candidate[],
  calibration: CalibrationExample[] = [],
  preferences: PreferenceExample[] = [],
  history: HistoryExample[] = [],
): Promise<RawMatch[]> {
  const { anthropic, textOf } = await import("./anthropic");

  const calibrationBlock = calibration.length
    ? `\n\nPreviously accepted/rejected examples for this person — calibrate your picks against these revealed preferences:\n${JSON.stringify(calibration)}\n`
    : "";

  // Stated/inferred preferences are stronger evidence than the static profile,
  // because the person volunteered them after seeing real suggestions. `avoids`
  // entries sourced from `decline_reason` are the reasons they turned someone
  // down — treat them as constraints, not colour.
  const preferenceBlock = preferences.length
    ? `\n\nWhat this person has told Dawn they want and don't want (higher confidence = stated more explicitly). ` +
      `Treat "avoids" as a hard filter unless a candidate clearly resolves the objection, and weigh these ABOVE the static profile ` +
      `— the profile is what they wrote once, these are what they've said since:\n${JSON.stringify(preferences)}\n`
    : "";

  const historyBlock = history.length
    ? `\n\nRecent things this person actually wrote back to Dawn, newest first — use them to read intent the profile misses:\n${JSON.stringify(history)}\n`
    : "";

  // Streamed rather than a plain create(), for the same reason /api/join/profile
  // is: adaptive thinking spends from the same max_tokens as the response, and a
  // budget this size risks an SDK HTTP timeout before the request finishes.
  // Streaming also retires the manual 30s timeout — the SDK scales its own
  // default for streamed requests.
  const stream = anthropic.messages.stream(
    {
      model: "claude-opus-5",
      // Raised from 4000 alongside the model bump, and the order matters: Opus 5
      // thinks by default when `thinking` is omitted, and max_tokens caps
      // thinking AND the response together. Bumping the model without the budget
      // truncates a shortlist mid-rationale, which reads as a quality regression
      // rather than a configuration error.
      max_tokens: 16000,
      // Ranking is the product's quality ceiling (spec §7), so thinking stays on.
      // `high` is Opus 5's default, set explicitly because that default has moved
      // between generations. Sweep medium/high/xhigh against the eval fixtures
      // before settling.
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: MATCH_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content:
            `Person: ${JSON.stringify({
              id: person.id,
              name: person.name,
              headline: person.headline,
              bio: person.bio,
              offering: person.offering,
              looking_for: person.looking_for,
              goals: person.goals,
              background: person.background,
              tags: person.tags,
              ask_must_haves: person.ask_must_haves,
              ask_nice_to_haves: person.ask_nice_to_haves,
            })}\n\n` +
            `Candidates (with preliminary vector-similarity scores and which direction surfaced them): ${JSON.stringify(candidates)}` +
            calibrationBlock +
            preferenceBlock +
            historyBlock +
            `\n\nSelect the ${SHORTLIST_MIN}-${SHORTLIST_MAX} best introductions for this person from the candidate list. For each, explain in 2-4 sentences why the introduction creates real mutual value — be specific about what one person offers that satisfies the other's stated ask (weigh must-haves heavily, nice-to-haves as a bonus), not just topical similarity. Assign a 0-1 score reflecting how strong and specific the match is. Use the candidate_id and name values exactly as given for the candidate you are describing in each entry — do not mix up which candidate a rationale is about.`,
        },
      ],
    },
  );
  const resp = await stream.finalMessage();

  const parsed = JSON.parse(textOf(resp));
  if (!Array.isArray(parsed?.matches)) {
    throw new Error("Claude returned malformed JSON — expected a `matches` array.");
  }
  return parsed.matches as RawMatch[];
}

/**
 * Cross-checks Claude's candidate_id against the name it echoed back, to catch
 * cases where a rationale and a candidate_id get swapped between two different
 * candidates in the model's output.
 */
export function validateMatches(ranked: RawMatch[], candidates: Candidate[]) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const byName = new Map(candidates.map((c) => [c.name.trim().toLowerCase(), c]));
  const valid: (RawMatch & { candidate: Candidate })[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const m of ranked) {
    if (!m.candidate_id || !m.rationale) {
      notes.push("Dropped a pick with missing candidate_id/rationale.");
      continue;
    }
    const byIdCandidate = byId.get(m.candidate_id) ?? null;
    const byNameCandidate = byName.get((m.name ?? "").trim().toLowerCase()) ?? null;

    let candidate: Candidate | null = byIdCandidate;
    if (!byIdCandidate && byNameCandidate) {
      candidate = byNameCandidate;
      notes.push(
        `Corrected: candidate_id "${m.candidate_id}" didn't match any candidate; remapped by name to ${byNameCandidate.name}.`,
      );
    } else if (byIdCandidate && byNameCandidate && byIdCandidate.id !== byNameCandidate.id) {
      candidate = byNameCandidate;
      notes.push(
        `Corrected: id/name mismatch (id pointed to ${byIdCandidate.name}, name said "${m.name}") — used the name match.`,
      );
    } else if (!byIdCandidate && !byNameCandidate) {
      notes.push(`Dropped: neither candidate_id "${m.candidate_id}" nor name "${m.name}" match any candidate.`);
      continue;
    }

    if (!candidate) continue;
    if (seen.has(candidate.id)) {
      notes.push(`Dropped duplicate pick for ${candidate.name}.`);
      continue;
    }
    seen.add(candidate.id);
    valid.push({ ...m, candidate_id: candidate.id, candidate });
  }

  return { valid, notes };
}
