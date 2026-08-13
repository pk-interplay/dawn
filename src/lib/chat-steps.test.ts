import { describe, expect, it } from "vitest";
import { MAX_STEPS, toSteps } from "./chat-steps";

// The trail is the only place a user sees the agent's fan-out, and the agent fans out
// hard — a single "who should I talk to this week?" turn hits searchNetwork five times.
// Rendering one line per tool part buried the reply under identical checkmarks. These
// lock the two properties that fix it: consecutive repeats collapse, and the list never
// exceeds MAX_STEPS with the newest entry always last (the render reads the last entry
// as the in-flight one, so trimming from the wrong end would spin a finished step).

const parts = (...names: string[]) => names.map((name) => ({ type: `tool-${name}` }));

describe("toSteps", () => {
  it("collapses a run of identical tool calls into one counted line", () => {
    const five = parts("searchNetwork", "searchNetwork", "searchNetwork", "searchNetwork", "searchNetwork");
    expect(toSteps(five)).toEqual([{ label: "Scanning your network", count: 5 }]);
  });

  it("keeps non-consecutive repeats separate so the order of work survives", () => {
    // A-B-A is three distinct beats of work, not "A ×2 then B".
    expect(toSteps(parts("searchNetwork", "findWarmPath", "searchNetwork"))).toEqual([
      { label: "Scanning your network", count: 1 },
      { label: "Working out your way in", count: 1 },
      { label: "Scanning your network", count: 1 },
    ]);
  });

  it("keeps only the most recent MAX_STEPS, dropping from the front", () => {
    const steps = toSteps(
      parts(
        "listTopConnections",
        "searchNetwork",
        "lookupByNameOrDomain",
        "getEntityProfile",
        "findWarmPath",
        "searchNetwork",
      ),
    );
    expect(steps).toHaveLength(MAX_STEPS);
    expect(steps.map((s) => s.label)).toEqual([
      "Pulling up their profile",
      "Working out your way in",
      "Scanning your network",
    ]);
  });

  it("counts a collapsed run as one step against the cap", () => {
    // Five scans plus two other tools is three lines, not seven — so nothing is trimmed.
    const steps = toSteps(
      parts("listTopConnections", "searchNetwork", "searchNetwork", "searchNetwork", "findWarmPath"),
    );
    expect(steps).toEqual([
      { label: "Going through who you know", count: 1 },
      { label: "Scanning your network", count: 3 },
      { label: "Working out your way in", count: 1 },
    ]);
  });

  it("labels unknown tools generically instead of leaking camelCase", () => {
    // Profile tools aren't in TOOL_LABELS; a raw "updateProfileField" in the UI is worse
    // than a vague line.
    expect(toSteps(parts("updateProfileField"))).toEqual([{ label: "Looking things up", count: 1 }]);
  });

  it("ignores text parts and returns nothing for a reply with no tool calls", () => {
    expect(toSteps([{ type: "text" }, { type: "step-start" }])).toEqual([]);
  });
});
