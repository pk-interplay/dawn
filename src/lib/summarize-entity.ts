import type { SupabaseClient } from "@supabase/supabase-js";
import { embed } from "./openai";

/**
 * Nexus v0.2 build step 3, `summarize_entity` (SPEC.md §5 row 4): claims →
 * prose for embedding. Haiku, json_schema structured output — the pattern
 * rerank.ts already uses correctly (SPEC §5.1: not `tool_choice`, which is
 * the pre-structured-outputs workaround `draftEmail`/`join/profile` still use
 * and should move away from).
 *
 * The only writer of `entities.summary`/`entities.embedding` — same "never
 * written by hand" rule as `display_name` (claims.ts::projectDisplayName).
 */

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

export async function summarizeEntity(client: SupabaseClient, entityId: string): Promise<{ summary: string; embedding: number[] }> {
  const { data: attrs, error } = await client
    .from("resolved_attributes")
    .select("attribute, value, method, confidence")
    .eq("subject_id", entityId);
  if (error) throw new Error(`summarizeEntity lookup failed: ${error.message}`);

  const { anthropic, textOf } = await import("./anthropic");
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: SUMMARY_SCHEMA } },
    messages: [
      {
        role: "user",
        content:
          `Claims about a person or organization, each with a method (self_reported/enriched/inferred/manual) ` +
          `and confidence: ${JSON.stringify(attrs ?? [])}\n\n` +
          `Write a 2-4 sentence prose summary suitable for embedding and semantic search. ` +
          `Prefer self-reported and higher-confidence claims; mention low-confidence or contested claims only if nothing else is available.`,
      },
    ],
  });

  const parsed = JSON.parse(textOf(resp));
  const summary: string = parsed.summary;
  const embedding = await embed(summary);

  const { error: updateError } = await client
    .from("entities")
    .update({ summary, embedding })
    .eq("id", entityId);
  if (updateError) throw new Error(`summarizeEntity write failed: ${updateError.message}`);

  return { summary, embedding };
}
