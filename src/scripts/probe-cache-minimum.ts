// Does prompt caching actually engage at the prefix sizes our LLM functions use?
//
// Tech spec §7.1 says "prompt caching on every function", and §8 prices
// `extract_signals` and `summarize_entity` — 40k of ~43k monthly calls — as
// "Haiku, batched, cached". That estimate only holds if the prefix clears the
// model's minimum cacheable length, and the minimum is NOT uniform:
//
//   Opus 5      512 tokens
//   Sonnet 5   1024 tokens
//   Haiku 4.5  4096 tokens   <-- the two highest-volume functions run here
//
// Below the minimum, caching silently does nothing: no error, no warning, just
// `cache_creation_input_tokens: 0` and full price on every call forever. A
// narrow extraction prompt plus a small schema lands well under 4096, so the
// cheapest tier is also the hardest one to cache — which is exactly backwards
// from how the cost model reads.
//
// This probe sweeps prefix sizes against each model and reports where caching
// actually starts working.
//
//   npx tsx src/scripts/probe-cache-minimum.ts
//
// Env: ANTHROPIC_API_KEY
//
// Cost: a few cents. Every call uses max_tokens: 16 and thinking disabled, so
// we pay for the prefix and almost no output.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// Documented minimums, for comparison against what we measure. If a measured
// threshold disagrees with the row here, trust the measurement and update the
// plan — these values have changed before (Opus 5 halved Opus 4.8's 1024).
const MODELS = [
  { id: "claude-haiku-4-5-20251001", documentedMinimum: 4096 },
  { id: "claude-sonnet-5", documentedMinimum: 1024 },
  { id: "claude-opus-5", documentedMinimum: 512 },
] as const;

// Chosen to bracket all three documented minimums from both sides.
const TARGET_PREFIX_TOKENS = [400, 700, 1200, 2500, 4500];

/**
 * Filler shaped like a real function prompt rather than repeated lorem ipsum.
 *
 * Caching keys on a byte-exact prefix, so what matters for the measurement is
 * only that the string is identical across the two calls and long enough. But
 * tokenization varies with content — prose, JSON, and code tokenize at
 * different ratios — so using text that resembles an actual system prompt plus
 * schema keeps the measured threshold transferable to the real functions.
 */
const FILLER_UNIT = `
You are an extraction function. Read the message below and return every factual
claim it contains about a person or organization. A claim is a single attribute
and value: a role, a company, a check size, an investment thesis, a location, a
contact detail. Do not infer claims that are not stated. Do not return opinions,
pleasantries, or scheduling logistics. Each claim carries a confidence between
zero and one reflecting how directly the message states it: near one when the
sender asserts it outright about themselves, lower when you are reading it off
a signature block or inferring it from context. Return an empty array when the
message contains no durable factual claims.
`.trim();

async function countTokens(model: string, text: string): Promise<number> {
  const res = await anthropic.messages.countTokens({
    model,
    system: [{ type: "text", text }],
    messages: [{ role: "user", content: "ok" }],
  });
  return res.input_tokens;
}

/**
 * Grow the filler until it clears `targetTokens`, measured with the real
 * tokenizer rather than a characters-per-token guess (which is wrong by enough
 * to straddle a threshold).
 */
async function buildPrefix(model: string, targetTokens: number): Promise<{ text: string; tokens: number }> {
  let copies = Math.max(1, Math.round(targetTokens / 120));
  for (let attempt = 0; attempt < 12; attempt++) {
    const text = Array.from({ length: copies }, (_, i) => `## Section ${i + 1}\n${FILLER_UNIT}`).join("\n\n");
    const tokens = await countTokens(model, text);
    if (tokens >= targetTokens) return { text, tokens };
    // Scale toward the target instead of incrementing, so this converges in
    // two or three round trips rather than dozens.
    copies = Math.max(copies + 1, Math.ceil(copies * (targetTokens / tokens)));
  }
  throw new Error(`Could not reach ${targetTokens} tokens for ${model}`);
}

interface Probe {
  prefixTokens: number;
  created: number;
  read: number;
  cached: boolean;
}

async function probe(model: string, prefix: string, prefixTokens: number): Promise<Probe> {
  const request = {
    model,
    max_tokens: 16,
    // Adaptive thinking is ON by default on Sonnet 5 and Opus 5. Left enabled
    // it would spend thinking tokens we do not need and make the probe cost
    // and latency noisy. Accepted on both (on Opus 5, `disabled` is valid at
    // effort `high` or below, and `high` is the default). Haiku 4.5 has no
    // thinking unless asked, so this is a no-op there.
    thinking: { type: "disabled" as const },
    system: [
      { type: "text" as const, text: prefix, cache_control: { type: "ephemeral" as const } },
    ],
    messages: [{ role: "user" as const, content: "Reply with the single word: ok" }],
  };

  // First call writes the cache (if the prefix is long enough to be cacheable).
  const write = await anthropic.messages.create(request);
  // Second call, byte-identical prefix, should read it. Sequential and
  // non-streaming on purpose: a cache entry only becomes readable once the
  // first response has begun, so concurrent calls would both miss.
  const read = await anthropic.messages.create(request);

  return {
    prefixTokens,
    created: write.usage.cache_creation_input_tokens ?? 0,
    read: read.usage.cache_read_input_tokens ?? 0,
    cached: (read.usage.cache_read_input_tokens ?? 0) > 0,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required.");
    process.exit(1);
  }

  for (const { id, documentedMinimum } of MODELS) {
    console.log(`\n${"=".repeat(72)}\n${id}  (documented minimum: ${documentedMinimum} tokens)\n${"=".repeat(72)}`);
    console.log("prefix tokens   cache_creation   cache_read   cached?");

    const results: Probe[] = [];
    for (const target of TARGET_PREFIX_TOKENS) {
      const { text, tokens } = await buildPrefix(id, target);
      const r = await probe(id, text, tokens);
      results.push(r);
      console.log(
        `${String(r.prefixTokens).padStart(13)}   ${String(r.created).padStart(14)}   ${String(r.read).padStart(10)}   ${r.cached ? "yes" : "NO"}`,
      );
    }

    const firstCached = results.find((r) => r.cached);
    const lastUncached = [...results].reverse().find((r) => !r.cached);
    if (!firstCached) {
      console.log(`\n  → Never cached up to ${results.at(-1)!.prefixTokens} tokens. Investigate before trusting §8.`);
    } else {
      const bound = lastUncached ? `between ${lastUncached.prefixTokens} and ${firstCached.prefixTokens}` : `at or below ${firstCached.prefixTokens}`;
      console.log(`\n  → Caching engages ${bound} tokens (documented: ${documentedMinimum}).`);
    }
  }

  console.log(
    [
      "",
      "-".repeat(72),
      "What to do with this:",
      "",
      "  Any function whose real prefix (system prompt + schema + few-shot)",
      "  falls below its model's threshold will never cache. Two responses,",
      "  in order of preference:",
      "",
      "   1. Lean on the Batch API instead — 50% off both directions, and",
      "      extract_signals / summarize_entity are sweeps, not interactive.",
      "      Spec §8 already assumes batching, so the estimate may survive.",
      "   2. Move the function up a tier. Opus 5 caches from 512 tokens, so a",
      "      short prompt caches there and does not on Haiku. Run the numbers:",
      "      a cached Opus call can beat an uncached Haiku one.",
      "",
      "  Do NOT pad a prompt to reach the minimum. At these volumes the extra",
      "  input tokens cost more than the cache saves, on every single call.",
      "-".repeat(72),
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
