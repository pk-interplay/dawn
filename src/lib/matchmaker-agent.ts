/**
 * The matchmaker. Dawn's hourly cadence, as an agent rather than a pipeline.
 *
 * What changed and what didn't
 * ────────────────────────────
 * The old run was a fixed loop: for each eligible member, fetch candidates, rerank,
 * take the top valid one, write a `matches` row. One LLM call, no memory, no way to
 * decline. It could not notice that a pair already talk every week, could not act on
 * "the last three intros I made for this person were all rejected for the same reason",
 * and started from zero every hour.
 *
 * What did NOT change is who enforces the rules. Every hard invariant — cadence
 * windows, `paused`, cohort separation, demo personas, already-introduced pairs, the
 * network master switch — is still plain code, evaluated before the model sees anything
 * and re-evaluated inside `proposeIntro` before anything is written. The agent chooses
 * among pairs that are ALREADY permitted, and can choose none. It cannot argue its way
 * past a rate limit, because the rate limit is not something it is asked about.
 *
 * That split is the whole design. Judgment is delegated; permission is not.
 *
 * Memory
 * ──────
 * `agent_notes` (0039) is where a run leaves something for the next one. It is
 * deliberately not `claims`: a claim is an attribute of a person that the ranker reads
 * as ground truth, and a matchmaker's working hypotheses are not that. See the table
 * comment in 0039.
 */

import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Person } from "./types";
import { fetchCandidates, fetchCalibration, fetchPreferences, fetchRecentHistory } from "./candidates";
import { startIntroduction } from "./intro-flow";
import { MODELS } from "./llm";

/**
 * `claude-opus-5`, matching rerank.ts rather than the chat agent's Sonnet.
 *
 * Same reasoning as the comment there: ranking is the product's quality ceiling and
 * this runs offline in a cron where latency is nearly free. The chat agent is
 * interactive and pays for its own speed.
 */
export const MATCHMAKER_MODEL = MODELS.rerank;

/**
 * Enough for: read notes → for a few members, pull candidates and context, maybe check
 * shared history → propose → write a note. Bounded because a cron with an unbounded
 * tool loop is a bill, not a feature.
 */
const MAX_STEPS = 40;

export interface EligibleMember {
  person: Person;
  /** Why this person is in the list — cadence window they cleared, for the model's context. */
  cadence: string;
}

export interface MatchmakerContext {
  client: SupabaseClient;
  /** Members who have already passed every deterministic gate. The model sees only these. */
  eligible: EligibleMember[];
  /** How many introductions this run may open. Enforced in code, not by the prompt. */
  limit: number;
  /** Identifies this run's notes so a bad run's memory can be retired together. */
  runId: string;
  /** Re-checked inside proposeIntro; mirrors the route's own gate. */
  isEligiblePair: (aId: string, bId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Epoch-ms wall-clock ceiling for the run — the route's maxDuration minus
   *  headroom. The loop is aborted rather than platform-killed, so the outcome
   *  still gets reported. */
  deadline?: number;
}

export interface MatchmakerOutcome {
  introductionsOpened: number;
  proposals: Array<{
    person: string;
    suggested: string;
    score: number;
    direction: string;
    introductionId: string | null;
    state: string;
    refused?: string;
  }>;
  notesWritten: number;
  summary: string;
}

const SYSTEM = `You are Dawn's matchmaker. Once an hour you look at the members who are due an introduction and decide who, if anyone, should meet.

You are not ranking a list. You are deciding whether there is an introduction here worth two people's time, and the honest answer is often no. An hour where you open nothing costs nobody anything. An hour where you force a mediocre pairing costs you the next one, because a member who has been sent two weak intros stops opening the third.

## What you have

- \`listEligibleMembers\` — the members you may act on this run. This list is already filtered: everyone on it has cleared their own cadence window, is not paused, and is in the right cohort. You cannot see or act on anyone else, and there is no way to ask for more.
- \`getCandidates\` — the people whose profiles are a vector match for one member, in both directions. \`surfaced_via\` tells you which: \`a_offers_b_wants\` (the member has what the candidate wants), \`b_offers_a_wants\` (the reverse), or \`mutual\`.
- \`getContext\` — three kinds of learned signal about a member: how they responded to past intros, durable preferences they stated or that were inferred from replies, and the last few things they actually wrote back to Dawn.
- \`getSharedHistory\` — whether two people already know each other, how strongly, and when they were last in touch.
- \`readNotes\` / \`writeNote\` — what previous runs learned. Yours to maintain.
- \`proposeIntro\` — opens the introduction.

## How to weigh it

Preferences beat profiles. A profile is what someone wrote once; a preference is what they said after seeing a real suggestion. Anything sourced from a decline reason is a constraint, not a hint — treat it as a filter unless a candidate plainly resolves the objection.

Directionality is the substance of a match. "Both work in fintech" is a topic overlap, not a reason to meet. One of them having specifically what the other is specifically looking for is. Say which way it runs, and if you cannot, that is usually a sign the match is weaker than it looked.

People who already talk regularly do not need Dawn. Check shared history before proposing a pair who look obviously compatible — obvious compatibility is exactly the condition under which two people have usually already met.

## Memory

Read your notes before you decide, and write one when a run teaches you something a future run would want. Good notes are specific and falsifiable: "rejected two infra-for-fintech intros citing stage mismatch — check funding stage before pairing on sector" earns its place. "Be thoughtful about matches" does not.

Write a \`correction\` when a note you previously wrote turns out to be wrong. Do not silently stop applying it — a corrected belief is more useful to the next run than an absent one.

Do not write a note about a person that belongs in their profile. Notes are about matchmaking; facts about people live elsewhere and you cannot write there.

## Ending the run

Stop when you have opened what the run allows, or when nothing left is worth opening. Then give a short plain summary of what you did and why — including declining, if that is what happened. Say it the way you would to a colleague who asked how the morning went.`;

/**
 * `select *` on people returns embeddings — two 1536-float arrays per row. Handing those
 * to the model is thousands of tokens of noise per candidate that it cannot use for
 * anything, so every person the model sees goes through this first.
 */
function forModel(p: Person) {
  return {
    id: p.id,
    name: p.name,
    headline: p.headline,
    bio: p.bio,
    offering: p.offering,
    looking_for: p.looking_for,
    tags: p.tags,
    industry: p.industry,
    career_stage: p.career_stage,
    location: p.location,
    intro_cadence: p.intro_cadence,
  };
}

export function createMatchmakerTools(ctx: MatchmakerContext, outcome: MatchmakerOutcome) {
  const { client } = ctx;
  const byId = new Map(ctx.eligible.map((e) => [e.person.id, e.person]));

  return {
    listEligibleMembers: tool({
      description:
        "The members you may open an introduction for this run. Already filtered for cadence, paused, and cohort. This is the complete set — there is no way to widen it.",
      inputSchema: z.object({}),
      execute: async () => ({
        limit: ctx.limit,
        opened: outcome.introductionsOpened,
        members: ctx.eligible.map((e) => ({ ...forModel(e.person), cadence: e.cadence })),
      }),
    }),

    getCandidates: tool({
      description:
        "Vector-matched candidates for one member, in both directions, already excluding people they rejected before and anyone ineligible.",
      inputSchema: z.object({
        personId: z.string().describe("A member id from listEligibleMembers."),
      }),
      execute: async ({ personId }) => {
        const person = byId.get(personId);
        // The model can only ever have got this id from listEligibleMembers, but an id
        // it invented must fail as data rather than as an exception that kills the run.
        if (!person) return { error: `${personId} is not a member you can act on this run.` };
        const { candidates } = await fetchCandidates(client, person);
        return {
          candidates: candidates.map((c) => ({
            id: c.id,
            name: c.name,
            headline: c.headline,
            offering: c.offering,
            looking_for: c.looking_for,
            tags: c.tags,
            similarity: Number(c.similarity.toFixed(3)),
            surfaced_via: c.surfaced_via,
          })),
        };
      },
    }),

    getContext: tool({
      description:
        "Learned signal about one member: past intro outcomes, stated/inferred preferences, and what they last wrote back to Dawn.",
      inputSchema: z.object({ personId: z.string() }),
      execute: async ({ personId }) => {
        const [calibration, preferences, history] = await Promise.all([
          fetchCalibration(client, personId),
          fetchPreferences(client, personId),
          fetchRecentHistory(client, personId),
        ]);
        return { calibration, preferences, history };
      },
    }),

    getSharedHistory: tool({
      description:
        "Whether two people already know each other: relationship strength (0-1), status, and when they were last in touch. Check before proposing a pair that looks obviously compatible.",
      inputSchema: z.object({ personAId: z.string(), personBId: z.string() }),
      execute: async ({ personAId, personBId }) => {
        // Queried through the generated person_low/person_high pair (0008) rather than
        // an or() over both orientations: the unique index is on those columns, and it
        // removes the question of which way round the row was written.
        const [low, high] = personAId < personBId ? [personAId, personBId] : [personBId, personAId];
        const { data, error } = await client
          .from("relationships")
          .select("strength, status, last_interaction_at")
          .eq("person_low", low)
          .eq("person_high", high)
          .maybeSingle();
        if (error) return { error: error.message };
        if (!data) return { known: false, note: "No recorded relationship between these two." };
        return {
          known: true,
          strength: data.strength,
          status: data.status,
          lastInteractionAt: data.last_interaction_at,
        };
      },
    }),

    readNotes: tool({
      description:
        "What previous runs learned. Omit personId for global heuristics; pass one for notes about a specific member; pass both for notes about that pair.",
      inputSchema: z.object({
        personId: z.string().nullish(),
        personBId: z.string().nullish(),
      }),
      execute: async ({ personId, personBId }) => {
        let q = client
          .from("agent_notes")
          .select("id, scope, note, kind, confidence, created_at")
          .eq("active", true)
          .order("confidence", { ascending: false })
          .limit(30);

        if (personId && personBId) {
          // Pair notes are stored in whichever order they were written, so both
          // orientations have to be asked for — see the reverse index in 0039.
          q = q
            .eq("scope", "pair")
            .or(
              `and(subject_id.eq.${personId},subject_b_id.eq.${personBId}),` +
                `and(subject_id.eq.${personBId},subject_b_id.eq.${personId})`,
            );
        } else if (personId) {
          q = q.eq("scope", "person").eq("subject_id", personId);
        } else {
          q = q.eq("scope", "global");
        }

        const { data, error } = await q;
        if (error) return { error: error.message };
        return { notes: data ?? [] };
      },
    }),

    writeNote: tool({
      description:
        "Record something a future run should know. Be specific and falsifiable. Use kind='correction' and pass supersedesId when a previous note was wrong.",
      inputSchema: z.object({
        note: z.string().min(1),
        kind: z.enum(["observation", "heuristic", "correction"]).default("observation"),
        confidence: z.number().min(0).max(1).default(0.5),
        personId: z.string().nullish(),
        personBId: z.string().nullish(),
        supersedesId: z.string().nullish(),
      }),
      execute: async ({ note, kind, confidence, personId, personBId, supersedesId }) => {
        const scope = personId && personBId ? "pair" : personId ? "person" : "global";
        const { data, error } = await client
          .from("agent_notes")
          .insert({
            scope,
            subject_id: personId ?? null,
            subject_b_id: personBId ?? null,
            note,
            kind,
            confidence,
            run_id: ctx.runId,
          })
          .select("id")
          .single();
        if (error) return { error: error.message };

        // Retire the superseded note rather than leaving two live contradictory beliefs
        // for the next run to arbitrate between.
        if (supersedesId) {
          const { error: supErr } = await client
            .from("agent_notes")
            .update({ active: false, superseded_by: data.id })
            .eq("id", supersedesId);
          if (supErr) return { id: data.id, warning: `note written, supersede failed: ${supErr.message}` };
        }
        outcome.notesWritten++;
        return { id: data.id, scope };
      },
    }),

    proposeIntro: tool({
      description:
        "Open an introduction between a member and a candidate. Every eligibility rule is re-checked here; a refusal comes back as a reason, so pick differently rather than retrying the same pair.",
      inputSchema: z.object({
        personId: z.string().describe("The member being helped (person A)."),
        candidateId: z.string().describe("The suggested match (person B)."),
        direction: z.enum(["a_offers_b_wants", "b_offers_a_wants", "mutual"]),
        score: z.number().min(0).max(1),
        rationale: z
          .string()
          .min(1)
          .describe("Why these two, in one or two sentences. This is read by a human."),
      }),
      execute: async ({ personId, candidateId, direction, score, rationale }) => {
        // ---- Re-check every gate, server-side ------------------------------
        // Not defensive politeness: the model has been holding a candidate list for
        // several tool calls by now, and the run limit in particular is the thing it is
        // most likely to talk itself past.
        if (outcome.introductionsOpened >= ctx.limit) {
          return { refused: `This run's limit of ${ctx.limit} introductions is already used.` };
        }
        const person = byId.get(personId);
        if (!person) return { refused: `${personId} is not a member you can act on this run.` };
        if (personId === candidateId) return { refused: "Cannot introduce someone to themselves." };

        const eligible = await ctx.isEligiblePair(personId, candidateId);
        if (!eligible.ok) return { refused: eligible.reason ?? "This pair is not eligible." };

        const { data: suggested, error: sErr } = await client
          .from("people")
          .select("*")
          .eq("id", candidateId)
          .maybeSingle();
        if (sErr) return { refused: `Could not load the candidate: ${sErr.message}` };
        if (!suggested) return { refused: `No such person: ${candidateId}` };

        // ---- Persist the match, then hand off to the state machine ---------
        const { data: matchRow, error: mErr } = await client
          .from("matches")
          .upsert(
            {
              person_a_id: personId,
              person_b_id: candidateId,
              score,
              direction,
              rationale,
            },
            { onConflict: "person_low,person_high" },
          )
          .select()
          .single();
        if (mErr) return { refused: `Could not record the match: ${mErr.message}` };

        try {
          const result = await startIntroduction(client, {
            helped: person,
            suggested: suggested as Person,
            matchId: matchRow?.id ?? null,
            direction,
            rationale,
          });
          outcome.introductionsOpened++;
          outcome.proposals.push({
            person: person.name,
            suggested: (suggested as Person).name,
            score,
            direction,
            introductionId: result.introductionId,
            state: result.state,
          });
          return {
            ok: true,
            introductionId: result.introductionId,
            state: result.state,
            // Said plainly so the model's summary doesn't claim a delivery that a closed
            // delivery gate means did not happen.
            note:
              result.state === "expired"
                ? "The introduction could not be opened and was marked expired."
                : "Introduction opened. Whether the email is delivered or held as a draft is decided by the send gateway, not by you.",
          };
        } catch (err) {
          // startIntroduction throws when the rate-limit ledger or the send gateway's
          // own safety checks fail. One bad pair must not end the run.
          const message = err instanceof Error ? err.message : String(err);
          outcome.proposals.push({
            person: person.name,
            suggested: (suggested as Person).name,
            score,
            direction,
            introductionId: null,
            state: "failed",
            refused: message,
          });
          return { refused: message };
        }
      },
    }),
  };
}

export function createMatchmakerAgent(ctx: MatchmakerContext, outcome: MatchmakerOutcome) {
  return new ToolLoopAgent({
    model: anthropic(MATCHMAKER_MODEL),
    // Cache breakpoint on the system message. Anthropic renders tools BEFORE
    // system, so this single marker caches the tool definitions + SYSTEM for all
    // of the run's up-to-40 steps — the largest recurring share of this run's
    // input spend. Requires createMatchmakerTools to stay deterministic:
    // reordering or renaming tools invalidates the cached prefix.
    instructions: {
      role: "system",
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    // Explicit for two reasons: the provider default is the model's 128k
    // ceiling, and a NON-STREAMING generate() with an implicit 128k max_tokens
    // is a request shape Anthropic rejects (long outputs require streaming).
    // 16k is comfortably enough for a step's thinking + tool call and keeps the
    // non-streaming call inside the timeout-safe range. generate() stays
    // non-streaming on purpose — a cron has no reader.
    maxOutputTokens: 16_000,
    maxRetries: 3,
    tools: createMatchmakerTools(ctx, outcome),
    stopWhen: stepCountIs(MAX_STEPS),
  });
}

/**
 * Run one matching pass. Returns what happened; never throws for ordinary failures.
 *
 * A run that dies takes the whole hour with it and there is no retry until the next
 * cron tick, so a model or provider error is caught, recorded in the summary, and
 * reported alongside whatever the run had already managed to do.
 */
export async function runMatchmaker(ctx: MatchmakerContext): Promise<MatchmakerOutcome> {
  const outcome: MatchmakerOutcome = {
    introductionsOpened: 0,
    proposals: [],
    notesWritten: 0,
    summary: "",
  };

  if (!ctx.eligible.length) {
    outcome.summary = "No members were due an introduction this run.";
    return outcome;
  }

  const agent = createMatchmakerAgent(ctx, outcome);

  const startedAt = Date.now();
  try {
    const result = await agent.generate({
      prompt:
        `Run ${ctx.runId}. ${ctx.eligible.length} member(s) are due an introduction and you may open up to ${ctx.limit}. ` +
        `Start by reading your notes, then decide. Opening none is a valid outcome.`,
      // Aborting at our own deadline (instead of being SIGKILLed at the route's
      // maxDuration) is what lets the catch below report a partial run.
      abortSignal:
        ctx.deadline !== undefined
          ? AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))
          : undefined,
    });
    outcome.summary = result.text?.trim() || "(the run produced no summary)";
    // totalUsage sums every step of the tool loop — the "what did this hourly
    // run cost" number, and (via cache_read) proof the prompt cache engaged.
    const { logLLMUsage, usageFromAISDK } = await import("./llm");
    await logLLMUsage(ctx.client, {
      site: "matchmaker",
      model: MATCHMAKER_MODEL,
      runId: ctx.runId,
      usage: usageFromAISDK(result.totalUsage ?? {}),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[matchmaker] run ${ctx.runId} failed: ${message}`);
    outcome.summary = `Run failed partway through: ${message}`;
  }

  return outcome;
}
