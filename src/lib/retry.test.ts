import { describe, expect, it, vi } from "vitest";
import { withRetry, type RetryPolicy } from "./retry";

// Keep test time real but tiny: baseMs in single-digit milliseconds.
function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    label: "[test]",
    classify: () => ({ kind: "transient", retryable: true, baseMs: 1 }),
    attempts: 3,
    ...overrides,
  };
}

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, policy())).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure and succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    await expect(withRetry(fn, policy())).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops at the attempt budget and rethrows the ORIGINAL error", async () => {
    const boom = new Error("still down");
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(withRetry(fn, policy({ attempts: 3 }))).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a terminal failure", async () => {
    const boom = new Error("bad request");
    const fn = vi.fn().mockRejectedValue(boom);
    const p = policy({ classify: () => ({ kind: "terminal", retryable: false }) });
    await expect(withRetry(fn, p)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than sleeping past the deadline", async () => {
    const boom = new Error("rate limited");
    const fn = vi.fn().mockRejectedValue(boom);
    // Provider asks for a 10s wait; only ~50ms remain. Sleeping is pointless.
    const p = policy({
      classify: () => ({ kind: "rate", retryable: true, retryAfterMs: 10_000 }),
      deadline: Date.now() + 50,
    });
    const started = Date.now();
    await expect(withRetry(fn, p)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("passes the attempt number through", async () => {
    const seen: number[] = [];
    const fn = vi.fn().mockImplementation(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error("again");
      return "done";
    });
    await expect(withRetry(fn, policy())).resolves.toBe("done");
    expect(seen).toEqual([1, 2, 3]);
  });
});
