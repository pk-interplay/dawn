import { describe, expect, it } from "vitest";

import { QuotaWindow, RunBudget, classifyGoogleFailure } from "./gmail-ingest";

/**
 * These two pieces are why a six-month ingest survives Gmail's per-minute quota, and
 * both were wrong (or absent) when a real mailbox first outran it: the 403 that means
 * "slow down" was classified as terminal, and nothing paced spend at all.
 */
describe("classifyGoogleFailure", () => {
  // The exact body Gmail returns when a user outruns 15,000 units/minute. A 403 whose
  // reason is rateLimitExceeded is a pacing signal, not a permission problem.
  const quotaBody = JSON.stringify({
    error: {
      code: 403,
      message:
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com'.",
      errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
      status: "PERMISSION_DENIED",
    },
  });

  it("treats a quota 403 as retriable, not terminal", () => {
    expect(classifyGoogleFailure(403, quotaBody)).toBe("quota");
  });

  it("still treats a real permission 403 as terminal", () => {
    const scopeBody = JSON.stringify({
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        errors: [{ domain: "global", reason: "insufficientPermissions" }],
      },
    });
    expect(classifyGoogleFailure(403, scopeBody)).toBe("terminal");
  });

  it("classifies concurrency 429s and 5xx separately from quota", () => {
    expect(classifyGoogleFailure(429, "Too many concurrent requests for user")).toBe("rate");
    expect(classifyGoogleFailure(503, "")).toBe("transient");
  });

  it("keeps 401 and 404 terminal", () => {
    expect(classifyGoogleFailure(401, "Invalid Credentials")).toBe("terminal");
    expect(classifyGoogleFailure(404, "Not Found")).toBe("terminal");
  });
});

describe("QuotaWindow", () => {
  it("lets spend through until the budget is reached, then makes callers wait", () => {
    const window = new QuotaWindow(100, 60_000);
    const t0 = 1_000_000;

    for (let i = 0; i < 20; i++) window.record(5, t0);
    expect(window.spentInWindow(t0)).toBe(100);
    // Full: the next 5 units have to wait for the oldest spend to leave the window.
    expect(window.waitFor(5, t0)).toBe(60_000);
    expect(window.waitFor(5, t0 + 59_000)).toBe(1_000);
    // Once the window has moved past every spend, there is room again.
    expect(window.waitFor(5, t0 + 60_001)).toBe(0);
  });

  it("only counts spend inside the trailing window", () => {
    const window = new QuotaWindow(100, 60_000);
    window.record(50, 1_000);
    window.record(50, 40_000);
    expect(window.spentInWindow(70_000)).toBe(50); // the 1s spend has aged out
    expect(window.waitFor(50, 70_000)).toBe(0);
  });

  it("stands every caller down while paused, even with budget to spare", () => {
    const window = new QuotaWindow(100, 60_000);
    const t0 = 1_000_000;
    window.pause(10_000, t0);
    expect(window.waitFor(5, t0)).toBe(10_000);
    expect(window.waitFor(5, t0 + 10_001)).toBe(0);
  });

  it("never shortens an existing pause", () => {
    const window = new QuotaWindow(100, 60_000);
    const t0 = 1_000_000;
    window.pause(20_000, t0);
    window.pause(5_000, t0);
    expect(window.waitFor(5, t0)).toBe(20_000);
  });
});

/**
 * The run budget is the hard "15,000 units per user per ingest" ceiling. Unlike the
 * window it never blocks — callers ask before spending and stop when the answer is
 * no, which is what turns an exhausted budget into a smaller graph rather than a 403.
 */
describe("RunBudget", () => {
  it("permits spend up to the ceiling and refuses past it", () => {
    const budget = new RunBudget(100);
    expect(budget.canAfford(100)).toBe(true);
    budget.charge(95);
    expect(budget.remaining()).toBe(5);
    expect(budget.canAfford(5)).toBe(true);
    expect(budget.canAfford(6)).toBe(false);
  });

  it("counts retries honestly and reports overshoot rather than hiding it", () => {
    const budget = new RunBudget(100);
    budget.charge(100);
    expect(budget.canAfford(5)).toBe(false);
    // An in-flight batch's retries still charge — remaining() floors at 0 while
    // spentUnits() keeps the true figure, so the run log can't understate the spend.
    budget.charge(15);
    expect(budget.remaining()).toBe(0);
    expect(budget.spentUnits()).toBe(115);
  });

  it("defaults to the documented 15,000-unit ceiling", () => {
    expect(new RunBudget().remaining()).toBe(15_000);
  });
});
