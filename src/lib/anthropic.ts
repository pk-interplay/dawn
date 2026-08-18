import Anthropic from "@anthropic-ai/sdk";
import "./env";

// Constructed lazily on first use — same rationale as src/lib/openai.ts: the SDK
// constructor throws without ANTHROPIC_API_KEY, so building it at module load
// forced every importer (including `next build` page-data collection and offline
// CI tests) to have the key present. Defer to the first API call via a Proxy that
// preserves the existing `anthropic.messages.create(...)` call shape.
let _anthropic: Anthropic | null = null;
function client(): Anthropic {
  // maxRetries: 0 — retry behavior lives in ONE place, src/lib/llm.ts's
  // callClaude (classified, deadline-aware, logged). The SDK default of 2
  // layered under that would multiply attempts: 2×4 = 8 provider calls in a
  // 529 storm.
  return (_anthropic ??= new Anthropic({ maxRetries: 0 }));
}

export const anthropic = new Proxy({} as Anthropic, {
  get(_t, prop) {
    const c = client();
    const value = Reflect.get(c, prop);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

export function textOf(resp: Anthropic.Messages.Message): string {
  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!block) throw new Error("No text block in Claude response");
  return block.text;
}
