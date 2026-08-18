// Free-text-ask rerank, shared by POST /api/find and the MCP server's
// find_people tool — which previously carried byte-identical copies of this
// function, schema and prompt, guaranteeing they'd drift.

import { z } from "zod";

const QUERY_RERANK_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          score: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["id", "name", "score", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
} as const;

// Runtime twin of the json_schema above.
const RankedPeopleSchema = z.object({
  people: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      score: z.number(),
      rationale: z.string(),
    }),
  ),
});

export type QueryRankedPerson = z.infer<typeof RankedPeopleSchema>["people"][number];

export async function rerankForQuery(
  query: string,
  candidates: Array<Record<string, unknown>>,
  deadline?: number,
): Promise<QueryRankedPerson[]> {
  const { anthropic, textOf } = await import("./anthropic");
  const { callClaude, MODELS } = await import("./llm");
  return callClaude(
    () =>
      anthropic.messages.create(
        {
          model: MODELS.intro,
          max_tokens: 4000,
          output_config: { format: { type: "json_schema", schema: QUERY_RERANK_SCHEMA } },
          messages: [
            {
              role: "user",
              content:
                `A caller is looking for people matching this ask: "${query}"\n\n` +
                `Candidates (with preliminary vector-similarity scores): ${JSON.stringify(candidates)}\n\n` +
                `Rank the candidates who genuinely fit the ask, best first. For each, write a 1-3 sentence rationale that is specific about what this person offers that satisfies the ask — not just topical overlap. Assign a 0-1 score for strength of fit. Use the id and name values exactly as given. Omit candidates that don't actually fit.`,
            },
          ],
        },
        { timeout: 30_000 },
      ),
    (resp) => RankedPeopleSchema.parse(JSON.parse(textOf(resp))).people,
    { label: "[rerankForQuery]", retryParse: true, deadline },
  );
}
