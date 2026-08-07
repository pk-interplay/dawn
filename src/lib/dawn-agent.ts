import { ToolLoopAgent, stepCountIs, type InferAgentUIMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createDawnTools, type DawnScope, type DawnToolContext } from "./network-tools";
import { buildPersonLikeView } from "./resolved-profile";

/**
 * Dawn, the chat agent.
 *
 * SPEC §6 originally said "No chat UI in Next.js; the conversational surface already
 * exists", meaning the MCP tools Hermes consumes. That has been amended in the spec:
 * Hermes is the OPERATOR surface over the whole graph, and this is the MEMBER surface,
 * scoped to one person's network with a toggle to the firm's. They are different
 * products with different boundaries, and the landing page's only CTA promised this one.
 *
 * Model is `claude-sonnet-5`, which means two Anthropic clients in this repo:
 * `@anthropic-ai/sdk` for rerank/summarize (single-shot, `output_config.effort`, json
 * schema) and `@ai-sdk/anthropic` here (streaming tool loop). Neither is cleanly
 * expressible through the other's API. They share ANTHROPIC_API_KEY. rerank.ts stays on
 * `claude-opus-5` deliberately — ranking is the product's quality ceiling and runs
 * offline in a cron; chat is interactive.
 */

export const DAWN_CHAT_MODEL = "claude-sonnet-5";

/** Enough for search → maybe a warm-path lookup → answer, without letting it wander. */
const MAX_STEPS = 8;

const SYSTEM = `You are Dawn — a super-connector working over Interplay's real relationship graph.

Everything you know about anyone comes from that graph: contacts synced from teammates' Gmail and Calendar metadata, plus claims people have stated or that were inferred about them. You know nothing else about anyone.

Ground every answer in tool results. Never invent a person, a company, a relationship, or an interaction. If a search comes back empty, say so plainly — "no one in the graph matches that" is a useful answer. A plausible-sounding guess is a liability here, because these are real people the user may actually go and contact. There is no web search and no external enrichment available to you: the graph is all there is, so "not in the graph" is a complete answer, not a reason to speculate.

## What the graph holds, and what it does not

- A relationship is a \`knows\` edge with a strength between 0 and 1 and a last-seen date, computed from how often and how recently two people emailed or shared a meeting. Strength SATURATES at 1.00 — anyone with a couple of recent emails pins there — so read 1.00 as "active", never as "the single closest person". Use lastSeen to separate ties, and say when a relationship looks dormant.
- The graph stores NO email or meeting CONTENT. Only metadata was ever read: who, when, and how often. You cannot summarize what two people discussed, quote a message, characterise someone's tone, or list what meetings were about. If asked, say so directly — you can say how strong and how recent a relationship is, and what the graph knows about the person, but not what was said. Do not soften this into a guess.
- Facts about a person are claims with provenance: a method (self_reported / enriched / inferred / manual), a confidence, an observed_at date, and two flags. \`contested\` means two live claims disagree — name both values and say they conflict rather than silently picking one. \`stale\` means the fact is over 90 days old — say it may be out of date. Surfacing these is the job, not a hedge.

## Entity ids

Every person is an entityId (a uuid). Only ever pass an entityId that a tool returned to you in THIS conversation. Never construct one, never guess one, never carry one over from earlier memory.

## About the person you're helping

{USER_CONTEXT}

Use this as background so your answers land closer to what they actually want. Don't recite it back unless they ask.

When someone asks "who should I meet" or "who should I talk to", treat what they're looking for above as the search query and call searchNetwork with it. Be clear that these are people who are in the graph — not the vetted introduction Dawn emails them, which comes from the matching engine and not from this conversation.

## Scope

{SCOPE_INSTRUCTIONS}

## Style

Concise and conversational. When you name someone, give the one or two facts that make them relevant, not a dossier. Prefer a short list of real people over a long hedge. Never show a raw entityId to the user — they are for your tool calls, not for reading.`;

const SCOPE_INSTRUCTIONS: Record<DawnScope, string> = {
  mine: `You are in "My network" — every tool is restricted to contacts this person synced from their own mailbox. You have no tool that can see any other teammate's contacts, so do not speculate about what one might contain. If a question is really "does anyone at Interplay know X" or "who could introduce me to Y", tell them you're scoped to their own network and that switching to "Everyone's network" gets the warm-path answer.`,

  all: `You are in "Everyone's network" — you can see every teammate's synced contacts, and every result tells you WHO the connection runs through. findWarmPath is this scope's reason to exist: reach for it by DEFAULT on anything shaped like "does anyone here know X", "who should make the intro", or "how do I get to someone at Acme". Always name the connector and say whose relationship it is: "Kevin has the strongest, most recent tie — he's the right person to ask." Never present a teammate's contact as though it were this person's own relationship. And note what you cannot say: there is no message content, so you cannot claim how OFTEN a connector talks to someone. "Kevin's tie is the strongest and most recent" is supported; "Kevin emails them weekly" is not.`,
};

/**
 * Build the "about the person you're helping" block from their confirmed profile.
 *
 * Uses `buildPersonLikeView`, which flattens `resolved_attributes` into the flat shape
 * rerank() expects — this is its first real consumer. Note it falls back to
 * `entities.display_name` for the name, which for a Gmail-only user is their email
 * address, so the thin case has to read acceptably rather than oddly.
 */
async function buildUserContext(client: SupabaseClient, entityId: string): Promise<string> {
  try {
    const person = await buildPersonLikeView(client, entityId);
    const lines = [
      `Name: ${person.name}`,
      person.headline ? `Headline: ${person.headline}` : null,
      person.bio ? `Bio: ${person.bio}` : null,
      person.looking_for ? `Looking for: ${person.looking_for}` : null,
      person.offering ? `Offering: ${person.offering}` : null,
      person.goals?.length ? `Working toward: ${person.goals.join("; ")}` : null,
      person.tags?.length ? `Expertise and interests: ${person.tags.join("; ")}` : null,
    ].filter(Boolean);

    if (lines.length <= 1) {
      return `${lines[0] ?? "Name: unknown"}\n(They haven't built out a profile yet, so you know little about them directly. Ask what they're looking for rather than guessing.)`;
    }
    return lines.join("\n");
  } catch (err) {
    // A missing profile must never take the chat down — an unpersonalised Dawn is far
    // better than a broken one.
    console.error("[dawn-agent] buildUserContext failed:", err);
    return "(Their profile could not be loaded. Ask what they're looking for rather than guessing.)";
  }
}

export async function createDawnAgent(ctx: DawnToolContext) {
  const userContext = await buildUserContext(ctx.client, ctx.viewerEntityId);
  const instructions = SYSTEM.replace("{USER_CONTEXT}", userContext).replace(
    "{SCOPE_INSTRUCTIONS}",
    SCOPE_INSTRUCTIONS[ctx.scope],
  );

  return new ToolLoopAgent({
    model: anthropic(DAWN_CHAT_MODEL),
    instructions,
    tools: createDawnTools(ctx),
    stopWhen: stepCountIs(MAX_STEPS),
  });
}

export type DawnAgent = Awaited<ReturnType<typeof createDawnAgent>>;
export type DawnAgentUIMessage = InferAgentUIMessage<DawnAgent>;
