import type Anthropic from "@anthropic-ai/sdk";

/**
 * Tool that lets an agent search the Dawn network for people who can help with
 * a free-text ask. Backed by POST /api/find (vector search + optional Claude
 * rerank). Register `findPeopleTool` in your tools array and route tool_use
 * blocks named "find_people" to `runFindPeople`.
 */

// Where the deployed API lives. Set DAWN_API_URL to your Vercel URL in prod;
// defaults to localhost for dev.
const BASE_URL = process.env.DAWN_API_URL ?? "http://localhost:3000";

export const findPeopleTool: Anthropic.Tool = {
  name: "find_people",
  description:
    "Search the Dawn network for real people who can help with a specific ask. " +
    "Use this whenever the user wants to be connected to, introduced to, or find someone — " +
    "e.g. an advisor, a hire, a design partner, an investor, or an expert on a topic. " +
    "Pass a natural-language description of WHO the user is looking for and WHAT they need help with, " +
    "written from the searcher's point of view (what they want), not the person's. " +
    "Good query: 'an experienced fintech founder who can advise on payments compliance'. " +
    "The tool returns matching people with their name, headline, what they offer, and what they're looking for. " +
    "Set rerank=true when you want the best few results with a written rationale for each fit (slower, higher quality); " +
    "leave it off for a fast, broader similarity list.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language description of who to find and what help is needed, from the searcher's perspective. " +
          "Be specific about the skill, role, or expertise required.",
      },
      limit: {
        type: "integer",
        description: "Max number of people to return (1-25). Default 10.",
      },
      rerank: {
        type: "boolean",
        description:
          "If true, Claude reranks the candidates by true fit and attaches a rationale per person, dropping poor fits. " +
          "Use for a curated shortlist; omit for a fast broad scan.",
      },
    },
    required: ["query"],
  },
};

export interface FindInput {
  query: string;
  limit?: number;
  rerank?: boolean;
}

/**
 * Executes the tool by calling the deployed /api/find endpoint. Return value is
 * meant to be fed back to the model as the tool_result content.
 */
export async function runFindPeople(input: FindInput): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/find`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const data = await resp.json();
  if (!resp.ok) {
    return `find_people failed (${resp.status}): ${data?.error ?? "unknown error"}`;
  }
  return JSON.stringify(data);
}
