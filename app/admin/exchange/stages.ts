import type { Step } from "./types";

/**
 * The six beats of a double opt-in, in order. The rail across the top of the
 * player is this list, and every email in the trail belongs to exactly one beat.
 */
export const STAGES = [
  { key: "ask_a", label: "Ask A", detail: "Dawn asks the person it's helping" },
  { key: "a_answers", label: "A answers", detail: "Their reply is read for intent" },
  { key: "ask_b", label: "Ask B", detail: "Only now is the other side contacted" },
  { key: "b_answers", label: "B answers", detail: "The second half of the opt-in" },
  { key: "introduced", label: "Introduced", detail: "Both in — one email to the two of them" },
  { key: "scheduling", label: "Scheduling", detail: "Times proposed, then settled" },
] as const;

/**
 * Which beat each email belongs to.
 *
 * Derived from the sequence rather than from `conversations.purpose`, because the
 * opt-in conversation is *flipped* to `purpose = 'scheduling'` in place once both
 * sides are in (see intro-flow.ts) — reading the purpose column would relabel A's
 * original opt-in ask as scheduling after the fact.
 *
 * Stages only ever move forward: a reply arriving on the scheduling thread reads
 * as scheduling, not as a re-run of "A answers".
 */
export function deriveStages(steps: Step[]): number[] {
  let floor = 0;
  let introduced = false;

  return steps.map((step) => {
    let raw: number;
    if (step.direction === "outbound") {
      const toA = step.recipients.some((r) => r.role === "a");
      const toB = step.recipients.some((r) => r.role === "b");
      // Addressed to both parties at once — this is the introduction itself.
      if (toA && toB) raw = 4;
      else raw = toB ? 2 : 0;
    } else {
      raw = step.speaker.role === "b" ? 3 : 1;
    }

    const stage = Math.max(raw, introduced ? 5 : floor);
    if (stage >= 4) introduced = true;
    floor = stage;
    return stage;
  });
}

/**
 * Stages that the run jumped straight over — most often `ask_b`/`b_answers` when
 * INTRO_TEST_SINGLE_SIDED auto-opted B in without ever emailing them. Shown as
 * skipped rather than pending, so the rail doesn't imply an email that never went out.
 */
export function skippedStages(stagesByStep: number[]): Set<number> {
  const reached = new Set(stagesByStep);
  const furthest = stagesByStep.length ? Math.max(...stagesByStep) : -1;
  const skipped = new Set<number>();
  for (let i = 0; i < furthest; i++) {
    if (!reached.has(i)) skipped.add(i);
  }
  return skipped;
}

/** One line naming what this email did, used as the caption during playback. */
export function stepCaption(step: Step, stage: number): string {
  const first = (name: string) => name.split(" ")[0];

  if (step.direction === "outbound") {
    if (stage === 4) return "Dawn introduces them to each other";
    if (stage === 5) return "Dawn proposes times";
    const to = step.recipients.map((r) => first(r.name ?? r.email))[0] ?? "them";
    return `Dawn asks ${to} whether they're open to it`;
  }

  const who = first(step.speaker.name);
  const opted = step.intent?.opted_in;
  if (step.intent?.requests_pause) return `${who} asks Dawn to stop`;
  if (opted === "yes") return `${who} says yes`;
  if (opted === "no") return `${who} declines`;
  if (step.intent?.chosen_time) return `${who} picks a time`;
  if (opted === "unclear") return `${who} replies — intent unclear`;
  return `${who} replies`;
}
