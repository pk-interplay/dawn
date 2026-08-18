import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QuotaWindow,
  RunBudget,
  classifyGoogleFailure,
  fetchHeaders,
  fetchRecentGmailHeaders,
  listMessageIds,
} from "./gmail-ingest";

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

/**
 * The retry itself, driven through the public entry point with `fetch` stubbed.
 *
 * This is the bug that caused the original outage, and a real run can't be relied
 * on to reproduce it — the measured ingest spent 2,955 of 15,000 units and never
 * came close to a rejection. Stubbing the transport is the only way to prove the
 * quota 403 is retried rather than raised.
 */
describe("googleFetch retry behaviour (via fetchRecentGmailHeaders)", () => {
  const QUOTA_403 = JSON.stringify({
    error: {
      code: 403,
      message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
      errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
      status: "PERMISSION_DENIED",
    },
  });

  const SCOPE_403 = JSON.stringify({
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      errors: [{ domain: "global", reason: "insufficientPermissions" }],
      status: "PERMISSION_DENIED",
    },
  });

  /** Queues canned responses; each fetch call shifts the next one off the front. */
  function stubFetch(responses: { status: number; body: string }[]) {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      const next = responses.shift() ?? { status: 200, body: JSON.stringify({ messages: [] }) };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: { get: () => null },
        text: async () => next.body,
        json: async () => JSON.parse(next.body),
      };
    });
    vi.stubGlobal("fetch", impl);
    return { impl, calls };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a quota 403 and completes the run", async () => {
    // Fake timers so the deliberate multi-second quota backoff doesn't make the
    // suite wait it out. QuotaWindow reads Date.now(), which vitest also fakes, so
    // the pause and the sleep advance together.
    vi.useFakeTimers();
    const { impl } = stubFetch([
      { status: 403, body: QUOTA_403 }, // first list call is rejected on quota
      { status: 200, body: JSON.stringify({ messages: [] }) }, // retry succeeds
    ]);

    // A token unique to this test: quota windows are cached per token at module
    // scope, so sharing one would leak this test's pause into the next.
    const pending = fetchRecentGmailHeaders("test-token-quota-retry", undefined, new RunBudget());
    await vi.advanceTimersByTimeAsync(60_000);
    const headers = await pending;

    expect(headers).toEqual([]);
    // The rejected call plus its retry, then the received-mail list.
    expect(impl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("raises a scope 403 immediately without retrying", async () => {
    const { impl } = stubFetch([{ status: 403, body: SCOPE_403 }]);

    await expect(
      fetchRecentGmailHeaders("test-token-scope-403", undefined, new RunBudget()),
    ).rejects.toThrow(/403/);

    // Terminal means terminal: one attempt, no backoff, no second call.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("puts a window's after: and before: into both directions' queries", async () => {
    const { calls } = stubFetch([]);

    const after = new Date("2026-07-19T00:00:00Z");
    const before = new Date("2026-08-18T00:00:00Z");
    await fetchRecentGmailHeaders(
      "test-token-window",
      undefined,
      new RunBudget(),
      undefined,
      undefined,
      undefined,
      { after, before },
    );

    const afterEpoch = Math.floor(after.getTime() / 1000);
    const beforeEpoch = Math.floor(before.getTime() / 1000);
    const queries = calls.map((url) => new URL(url).searchParams.get("q"));
    expect(queries).toHaveLength(2); // sent list + received list; nothing to fetch
    for (const q of queries) {
      expect(q).toContain(`after:${afterEpoch}`);
      expect(q).toContain(`before:${beforeEpoch}`);
    }
  });

  it("defaults to the six-month lookback with no before: when no window is given", async () => {
    const { calls } = stubFetch([]);

    await fetchRecentGmailHeaders("test-token-default-window", undefined, new RunBudget());

    const q = new URL(calls[0]).searchParams.get("q")!;
    expect(q).not.toContain("before:");
    const after = Number(q.match(/after:(\d+)/)?.[1]);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    // Within a day of six months back — locks the default without pinning the clock.
    expect(Math.abs(after * 1000 - sixMonthsAgo.getTime())).toBeLessThan(86_400_000);
  });
});

/**
 * The listing's truncation report is what tells the backfill "the window is
 * drained" apart from "a limit stopped us" — the difference between clearing
 * the cursor forever and advancing it. Driven with fetch stubbed, same harness
 * as above.
 */
describe("listMessageIds truncation reporting", () => {
  function stubPages(pages: { ids: string[]; nextPageToken?: string }[]) {
    const impl = vi.fn(async () => {
      const next = pages.shift() ?? { ids: [] };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "",
        json: async () => ({
          messages: next.ids.map((id) => ({ id })),
          nextPageToken: next.nextPageToken,
        }),
      };
    });
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports truncated: null when the listing drains", async () => {
    stubPages([{ ids: ["a", "b"] }]);
    const result = await listMessageIds("t-drain", new RunBudget(), "q", 100, "test");
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.truncated).toBeNull();
  });

  it("reports truncated: 'cap' when pages remain past the cap", async () => {
    stubPages([{ ids: ["a", "b"], nextPageToken: "more" }]);
    const result = await listMessageIds("t-cap", new RunBudget(), "q", 2, "test");
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.truncated).toBe("cap");
  });

  it("reports truncated: 'budget' when the run budget cannot afford a page", async () => {
    stubPages([{ ids: ["a"], nextPageToken: "more" }]);
    // Exactly one list call's worth: the second page is unaffordable.
    const result = await listMessageIds("t-budget", new RunBudget(5), "q", 100, "test");
    expect(result.ids).toEqual(["a"]);
    expect(result.truncated).toBe("budget");
  });

  it("reports truncated: 'time' when the deadline has passed", async () => {
    stubPages([]);
    const result = await listMessageIds(
      "t-time",
      new RunBudget(),
      "q",
      100,
      "test",
      Date.now() - 1,
    );
    expect(result.ids).toEqual([]);
    expect(result.truncated).toBe("time");
  });
});

/** internalDate is the backfill cursor's key — see GmailHeaderSet. */
describe("fetchHeaders internalDate mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps Gmail's internalDate (epoch-ms string) onto internalDateMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "",
        json: async () => ({
          id: "m1",
          threadId: "t1",
          internalDate: "1755500000000",
          payload: { headers: [{ name: "From", value: "Ava <ava@example.com>" }] },
        }),
      })),
    );

    const [header] = await fetchHeaders("t-internal", new RunBudget(), ["m1"], "test");
    expect(header.internalDateMs).toBe(1_755_500_000_000);
    expect(header.from).toBe("Ava <ava@example.com>");
  });
});
