/**
 * The "here's what Dawn is doing" trail that sits above each reply in the chat.
 *
 * Lives outside the client component so the fold is a plain pure function and can be
 * tested without rendering. The agent fans out — five `searchNetwork` calls in one turn
 * is normal — so the raw tool parts would render five identical lines. Consecutive
 * repeats collapse into one counted line, and only the most recent few survive.
 */

/** Human labels for the tool-status trail. Unknown tools fall back to a generic line. */
export const TOOL_LABELS: Record<string, string> = {
  searchNetwork: "Scanning your network",
  lookupByNameOrDomain: "Checking names and companies",
  listTopConnections: "Going through who you know",
  getEntityProfile: "Pulling up their profile",
  findWarmPath: "Working out your way in",
};

const FALLBACK_LABEL = "Looking things up";

/** Longer than this and the trail stops reading as a summary and starts reading as spam. */
export const MAX_STEPS = 3;

export interface ChatStep {
  label: string;
  count: number;
}

/**
 * Turn AI SDK message parts into at most `MAX_STEPS` status lines.
 *
 * Only *consecutive* runs merge, so an A-B-A sequence stays three lines and the trail
 * still reflects the real order of work. Trimming drops from the front, which keeps the
 * newest entry last — the render leans on that to know which line is still in flight.
 */
export function toSteps(parts: Array<{ type: string }>): ChatStep[] {
  const steps: ChatStep[] = [];

  for (const part of parts) {
    if (!part.type.startsWith("tool-")) continue;
    const label = TOOL_LABELS[part.type.slice("tool-".length)] ?? FALLBACK_LABEL;
    const last = steps[steps.length - 1];
    if (last?.label === label) last.count += 1;
    else steps.push({ label, count: 1 });
  }

  return steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;
}
