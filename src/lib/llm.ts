// The one place raw Anthropic SDK calls get their armor: a model registry, a
// classified retry wrapper, and usage logging.
//
// Before this file, every LLM call in the repo ran bare: no 429/529 handling
// beyond the SDK's silent default retries, unguarded JSON.parse on model output
// in five places, four hardcoded model strings across six files, and no record
// of what anything cost. The Gmail side had all of this (gmail-ingest.ts) — the
// model side never got it.
//
// AI SDK call sites (dawn-agent, matchmaker-agent, synthesize-profile) are NOT
// wrapped here: a tool loop has side effects and cannot be blindly re-run from
// outside. They get explicit `maxRetries` and an `abortSignal` derived from the
// route deadline instead.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withRetry, type Classified, type Deadline } from "./retry";

/**
 * Every production model string, in one place. Centralized as-is — no model
 * changes here. Note `cheap` carries a date suffix the others don't; normalizing
 * it to `claude-haiku-4-5` is a separate decision.
 */
export const MODELS = {
  /** Match ranking — the product's quality ceiling (rerank.ts, matchmaker-agent.ts). */
  rerank: "claude-opus-5",
  /** Conversational surfaces (dawn-agent.ts, synthesize-profile.ts). */
  chat: "claude-sonnet-5",
  /** Intro drafting + reply parsing + query rerank (intro-flow.ts, query-rerank.ts). */
  intro: "claude-opus-4-8",
  /** High-volume structured extraction (summarize-entity.ts, derive-asks.ts). */
  cheap: "claude-haiku-4-5-20251001",
} as const;

/** Model output that failed schema validation — retryable once via retryParse. */
export class LLMParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
    this.name = "LLMParseError";
  }
}

/** The model spent its whole max_tokens budget — a config bug, never retried. */
export class LLMTruncatedError extends Error {
  constructor(label: string) {
    super(
      `${label} response hit max_tokens — the output (and any thinking) exceeded the ` +
        `configured budget. Retrying rebuys the same truncation; raise max_tokens instead.`,
    );
    this.name = "LLMTruncatedError";
  }
}

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: { get?: (k: string) => string | null } })?.headers;
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Most-specific-first, using the SDK's typed error classes — never string
 * matching. Terminal 4xx (bad request, auth, permission, not found) means the
 * request itself is wrong; retrying rebuys the same failure.
 */
export function classifyAnthropicFailure(err: unknown): Classified {
  if (err instanceof LLMTruncatedError) return { kind: "truncated", retryable: false };
  if (err instanceof LLMParseError) return { kind: "parse", retryable: true, baseMs: 500 };
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate", retryable: true, retryAfterMs: retryAfterMs(err), baseMs: 2000 };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    if (status === 529) return { kind: "overloaded", retryable: true, baseMs: 5000 };
    if (status !== undefined && status >= 500) return { kind: "transient", retryable: true, baseMs: 1000 };
    if (err instanceof Anthropic.APIConnectionError) return { kind: "transient", retryable: true, baseMs: 1000 };
    return { kind: "terminal", retryable: false };
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { kind: "transient", retryable: true, baseMs: 1000 };
  }
  return { kind: "terminal", retryable: false };
}

export interface LLMCallOptions {
  /** Prefix for log lines, e.g. "[parseReplyIntent]". */
  label: string;
  deadline?: Deadline;
  /** Total tries including the first. Default 4. */
  attempts?: number;
  /** Re-issue the whole call ONCE when the output fails schema validation. */
  retryParse?: boolean;
}

/**
 * Run one raw-SDK model call with classified retry, then parse its output.
 *
 * `parse` runs INSIDE the retry loop, so schema-invalid output can re-issue the
 * call (once, when retryParse is set) — but a response that stopped on
 * max_tokens is thrown terminally first: with json_schema output a parse failure
 * usually IS truncation, and retrying a config bug just pays for it twice.
 *
 * Requires src/lib/anthropic.ts to construct the client with maxRetries: 0 —
 * layering the SDK's silent retries under these multiplies attempts (2×4 = 8
 * provider calls in a 529 storm).
 */
export async function callClaude<T>(
  fn: () => Promise<Anthropic.Messages.Message>,
  parse: (resp: Anthropic.Messages.Message) => T,
  opts: LLMCallOptions,
): Promise<T> {
  let parseFailures = 0;
  return withRetry(
    async () => {
      const started = Date.now();
      const resp = await fn();
      // Console-only spend line for every raw-SDK call; sites that want a DB row
      // (the cron loops) call logLLMUsage with a client themselves.
      void logLLMUsage(null, {
        site: opts.label.replace(/[[\]]/g, ""),
        model: resp.model,
        usage: resp.usage ?? {},
        durationMs: Date.now() - started,
      });
      if (resp.stop_reason === "max_tokens") {
        const err = new LLMTruncatedError(opts.label);
        console.error(err.message);
        throw err;
      }
      try {
        return parse(resp);
      } catch (err) {
        if (err instanceof LLMParseError) throw err;
        throw new LLMParseError(
          `${opts.label} output failed validation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    {
      label: opts.label,
      deadline: opts.deadline,
      attempts: opts.attempts ?? 4,
      classify: (err) => {
        const c = classifyAnthropicFailure(err);
        if (c.kind === "parse") {
          // Parse retries are capped at one regardless of the attempt budget —
          // a model that produced invalid output twice will keep producing it.
          return { ...c, retryable: Boolean(opts.retryParse) && parseFailures++ < 1 };
        }
        return c;
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Usage logging
// ---------------------------------------------------------------------------

export interface UsageRow {
  /** Call site: "matchmaker" | "chat" | "rerank" | "parse_reply" | … */
  site: string;
  model: string;
  /** Correlates the calls of one run: cron runId, chat threadId, or null. */
  runId?: string | null;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  durationMs: number;
}

/** Adapt the AI SDK's LanguageModelUsage shape to the raw-SDK field names. */
export function usageFromAISDK(u: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}): UsageRow["usage"] {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cachedInputTokens,
  };
}

/**
 * Record what a model call cost. A structured console line ALWAYS (so Vercel
 * logs answer "what did the hourly run cost" even if the insert fails); the
 * llm_usage row best-effort — spend accounting must never fail the work it
 * accounts for. `cache_read_tokens` is also how caching is verified to engage.
 */
export async function logLLMUsage(client: SupabaseClient | null, row: UsageRow): Promise<void> {
  const u = row.usage;
  console.log(
    `[llm-usage] site=${row.site} model=${row.model} run=${row.runId ?? "-"} ` +
      `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
      `ms=${row.durationMs}`,
  );
  if (!client) return;
  try {
    const { error } = await client.from("llm_usage").insert({
      site: row.site,
      model: row.model,
      run_id: row.runId ?? null,
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_tokens: u.cache_read_input_tokens ?? null,
      cache_write_tokens: u.cache_creation_input_tokens ?? null,
      duration_ms: row.durationMs,
    });
    if (error) console.warn(`[llm-usage] insert failed: ${error.message}`);
  } catch (err) {
    console.warn(`[llm-usage] insert failed:`, err);
  }
}
