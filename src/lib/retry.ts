// One classified-retry engine, shared by the LLM helper (src/lib/llm.ts) and the
// send gateway's transmit step. It is googleFetch's proven posture
// (src/lib/gmail-ingest.ts) extracted for callers that aren't Google: classify the
// failure → honor an explicit retry-after → exponential backoff with jitter → cap
// → never sleep past the caller's deadline.

/** Epoch-ms deadline; undefined = unbounded. Same shape as gmail-ingest's. */
export type Deadline = number | undefined;

export const timeLeft = (deadline: Deadline): number =>
  deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();

export interface Classified {
  /** Short label for logs: "rate", "overloaded", "transient", "terminal", "parse"… */
  kind: string;
  retryable: boolean;
  /** Provider-stated wait (Retry-After), when it sent one. */
  retryAfterMs?: number;
  /** First-attempt backoff for this kind; doubles per attempt. Default 1000. */
  baseMs?: number;
}

export interface RetryPolicy {
  classify(err: unknown): Classified;
  /** Total tries including the first. Default 4. */
  attempts?: number;
  maxBackoffMs?: number;
  deadline?: Deadline;
  /** Prefix for log lines, e.g. "[parseReplyIntent]". */
  label: string;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it succeeds, the policy calls a failure terminal, attempts run
 * out, or the next backoff would not fit in the remaining deadline. Always
 * rethrows the ORIGINAL error — classification decides whether to retry, never
 * what the caller ultimately sees.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  const attempts = policy.attempts ?? DEFAULT_ATTEMPTS;
  const maxBackoff = policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const c = policy.classify(err);
      if (!c.retryable || attempt >= attempts) throw err;

      let backoff =
        c.retryAfterMs !== undefined && c.retryAfterMs > 0
          ? c.retryAfterMs
          : (c.baseMs ?? 1000) * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      backoff = Math.min(backoff, maxBackoff);

      // No point sleeping past the deadline only to fail after it.
      if (backoff >= timeLeft(policy.deadline)) throw err;

      console.warn(
        `${policy.label} ${c.kind} failure (attempt ${attempt}/${attempts}); retrying in ${Math.round(backoff)}ms`,
      );
      await sleep(backoff);
    }
  }
}
