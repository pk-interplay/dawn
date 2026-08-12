import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { embed } from "./openai";

/**
 * The tools Dawn's chat answers from. Ported from nexus's network-tools.ts onto the
 * claims model, with three dropped, two upgraded, and one added.
 *
 * ## The security property, which is structural rather than prompted
 *
 * `DawnToolContext` is closed over per request and NOTHING in it is a tool input. The
 * model cannot name a viewer, cannot widen a scope, and cannot pass a connector list —
 * those come from the session every time. Two specific consequences:
 *
 *   - In "mine" scope `findWarmPath` is ABSENT FROM THE TOOL MAP. Not gated at execute
 *     time, not present-and-refusing: the model has no handle on cross-member data at
 *     all. nexus had this property and it is worth preserving exactly.
 *   - `getEntityProfile` is the one tool whose input is an identifier rather than a
 *     search string, and conversation history survives a scope flip — so it verifies
 *     reachability before returning. See its comment.
 *
 * `isYou` is always computed by comparing ids server-side, never asserted by the model.
 *
 * ## What the data cannot do, and why the prompt has to say so
 *
 * Ingest is metadata-only: `edges` carries a strength and an `observed_at` and nothing
 * else. No message content exists anywhere, so "summarize my relationship with X" —
 * one of nexus's four suggestion chips — is unanswerable here. And `strength` is
 * `min(1, (emails + 3*meetings) * 0.5^(ageDays/90))`, which SATURATES: anyone with a
 * couple of recent emails pins at exactly 1.00, so "strongest" is a large tied block
 * and recency is the real discriminator. Every ranking below orders
 * `strength desc nulls last, observed_at desc` and returns `lastSeen` for that reason.
 */

export type DawnScope = "mine" | "all";

export interface DawnToolContext {
  client: SupabaseClient;
  /**
   * Service-role handle, used by NOTHING in this file — the profile tools
   * (profile-tools.ts) are the only writers, and only to the viewer's own claims.
   * It rides in this context because both tool sets are built from one object in
   * dawn-agent.ts.
   */
  writeClient: SupabaseClient;
  viewerEntityId: string;
  viewerEmail: string;
  scope: DawnScope;
}

/** Shared row shape so every tool answers in the same vocabulary. */
interface PersonHit {
  entityId: string;
  name: string | null;
  summary: string | null;
  strength: number | null;
  lastSeen: string | null;
  connectedVia: { entityId: string; name: string | null; isYou: boolean } | null;
}

const SATURATION_NOTE =
  "Strength saturates at 1.00, so many contacts tie at the top — lastSeen is the real " +
  "discriminator among them.";

function connectorIdsFor(ctx: DawnToolContext): string[] | null {
  return ctx.scope === "mine" ? [ctx.viewerEntityId] : null;
}

function toHit(
  ctx: DawnToolContext,
  row: {
    id: string;
    display_name: string | null;
    summary: string | null;
    strength: number | string | null;
    observed_at: string | null;
    connector_id: string | null;
    connector_name: string | null;
  },
): PersonHit {
  return {
    entityId: row.id,
    name: row.display_name,
    summary: row.summary,
    strength: row.strength === null ? null : Number(row.strength),
    lastSeen: row.observed_at,
    connectedVia: row.connector_id
      ? {
          entityId: row.connector_id,
          name: row.connector_name,
          isYou: row.connector_id === ctx.viewerEntityId,
        }
      : null,
  };
}

// Returns `ToolSet` rather than a precise per-scope object type. The two scopes
// genuinely return different shapes, and a union of them makes `findWarmPath`
// optional — which `ToolLoopAgent`'s index signature rejects, since a tool may not be
// `undefined`. The scope guarantee is a RUNTIME one (the key is absent, so the model
// has no handle on it) and is asserted in network-tools.test.ts, not in the type.
export function createDawnTools(ctx: DawnToolContext): ToolSet {
  const connectorIds = connectorIdsFor(ctx);

  const searchNetwork = tool({
    description:
      "Semantic search over people in the network by what they do or care about. Use " +
      "this for descriptions — 'seed-stage fintech founders', 'someone who can advise " +
      "on payments compliance'. For an exact name or a company domain use " +
      "lookupByNameOrDomain instead, which matches email domains this cannot. " +
      SATURATION_NOTE,
    inputSchema: z.object({
      query: z.string().describe("Natural-language description of who to find."),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    execute: async ({ query, limit }) => {
      const queryEmbedding = await embed(query);
      const { data, error } = await ctx.client.rpc("match_entities_in_network", {
        query_embedding: queryEmbedding,
        exclude_id: ctx.viewerEntityId,
        connector_ids: connectorIds,
        match_count: limit,
      });
      if (error) return { error: error.message };
      return {
        scope: ctx.scope,
        results: (data ?? []).map((row: Parameters<typeof toHit>[1] & { similarity: number }) => ({
          ...toHit(ctx, row),
          similarity: Number(row.similarity),
        })),
      };
    },
  });

  const lookupByNameOrDomain = tool({
    description:
      "Find people by an exact-ish name, email address, or company domain. This is the " +
      "right tool for 'who do I know at X' — it matches email domains, which semantic " +
      "search over a prose summary misses entirely.",
    inputSchema: z.object({
      needle: z
        .string()
        .describe("A name fragment, email address, or company domain (e.g. 'anthropic.com')."),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    execute: async ({ needle, limit }) => {
      const { data, error } = await ctx.client.rpc("find_entities_by_contact", {
        needle,
        connector_ids: connectorIds,
        match_count: limit,
      });
      if (error) return { error: error.message };
      return {
        scope: ctx.scope,
        results: (data ?? []).map(
          (row: Parameters<typeof toHit>[1] & { matched_on: string }) => ({
            ...toHit(ctx, row),
            matchedOn: row.matched_on,
          }),
        ),
      };
    },
  });

  const listTopConnections = tool({
    description:
      "The viewer's most active relationships, ranked by strength then recency. " +
      SATURATION_NOTE,
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    execute: async ({ limit }) => {
      let query = ctx.client
        .from("edges")
        .select(
          "strength, source, observed_at, " +
            "contact:entities!edges_to_id_fkey(id, display_name, summary), " +
            "connector:entities!edges_from_id_fkey(id, display_name)",
        )
        .eq("kind", "knows");
      if (ctx.scope === "mine") query = query.eq("from_id", ctx.viewerEntityId);

      const { data, error } = await query
        .order("strength", { ascending: false, nullsFirst: false })
        .order("observed_at", { ascending: false })
        .limit(limit * 3); // over-fetch: "all" scope dedupes by contact below
      if (error) return { error: error.message };

      type Row = {
        strength: number | string | null;
        observed_at: string | null;
        contact: { id: string; display_name: string | null; summary: string | null } | null;
        connector: { id: string; display_name: string | null } | null;
      };

      // Keep the strongest connector per contact. In "all" scope the same person is
      // reachable through several teammates, and listing them once each reads as
      // several different people.
      // PostgREST types a nested embed as an array — it cannot infer cardinality from
      // the select string — but an explicit `!fkey` hint on a to-one relation returns a
      // single object at runtime. Hence the cast through `unknown`.
      const best = new Map<string, PersonHit>();
      for (const row of (data ?? []) as unknown as Row[]) {
        if (!row.contact) continue;
        if (best.has(row.contact.id)) continue;
        best.set(
          row.contact.id,
          toHit(ctx, {
            id: row.contact.id,
            display_name: row.contact.display_name,
            summary: row.contact.summary,
            strength: row.strength,
            observed_at: row.observed_at,
            connector_id: row.connector?.id ?? null,
            connector_name: row.connector?.display_name ?? null,
          }),
        );
      }
      return { scope: ctx.scope, results: [...best.values()].slice(0, limit) };
    },
  });

  const getEntityProfile = tool({
    description:
      "Everything the graph knows about one person, with provenance: where each fact " +
      "came from, how confident it is, when it was observed, and whether it is " +
      "contested (two live sources disagree) or stale (over 90 days old). Pass an " +
      "entityId a previous tool returned in THIS conversation — never construct one. " +
      "Pass the viewer's own entityId to show them their own profile.",
    inputSchema: z.object({
      entityId: z.string().uuid().describe("An entityId returned by another tool in this conversation."),
    }),
    execute: async ({ entityId }) => {
      // The one tool taking an identifier rather than a search string, and message
      // history survives a scope flip — so in "mine" scope the model could otherwise
      // replay an entityId it learned during an earlier "all"-scope turn. Reachability
      // is checked here rather than trusted.
      if (ctx.scope === "mine" && entityId !== ctx.viewerEntityId) {
        const { count, error } = await ctx.client
          .from("edges")
          .select("id", { count: "exact", head: true })
          .eq("kind", "knows")
          .eq("from_id", ctx.viewerEntityId)
          .eq("to_id", entityId);
        if (error) return { error: error.message };
        if (!count) {
          return {
            error:
              "That person isn't in your own network. Switch to Everyone's network to " +
              "see who is connected to them.",
          };
        }
      }

      const [entityRes, attrRes, edgeRes] = await Promise.all([
        ctx.client
          .from("entities")
          .select("id, kind, display_name, summary")
          .eq("id", entityId)
          .maybeSingle(),
        // resolved_attributes, never the claims table directly — the CI grep guard
        // confines that access to src/lib/claims.ts, and the view is the resolved
        // answer anyway.
        ctx.client
          .from("resolved_attributes")
          .select("attribute, value, source, method, confidence, observed_at, evidence, contested, stale")
          .eq("subject_id", entityId),
        ctx.client
          .from("edges")
          .select("strength, observed_at, connector:entities!edges_from_id_fkey(id, display_name)")
          .eq("kind", "knows")
          .eq("to_id", entityId)
          .order("strength", { ascending: false, nullsFirst: false }),
      ]);

      if (entityRes.error) return { error: entityRes.error.message };
      if (!entityRes.data) return { error: "No such entity." };
      if (attrRes.error) return { error: attrRes.error.message };
      if (edgeRes.error) return { error: edgeRes.error.message };

      type EdgeRow = {
        strength: number | string | null;
        observed_at: string | null;
        connector: { id: string; display_name: string | null } | null;
      };
      const connectors = ((edgeRes.data ?? []) as unknown as EdgeRow[])
        .filter((e) => e.connector)
        .filter((e) => ctx.scope === "all" || e.connector!.id === ctx.viewerEntityId)
        .map((e) => ({
          entityId: e.connector!.id,
          name: e.connector!.display_name,
          isYou: e.connector!.id === ctx.viewerEntityId,
          strength: e.strength === null ? null : Number(e.strength),
          lastSeen: e.observed_at,
        }));

      return {
        entityId: entityRes.data.id,
        kind: entityRes.data.kind,
        name: entityRes.data.display_name,
        summary: entityRes.data.summary,
        isYou: entityRes.data.id === ctx.viewerEntityId,
        attributes: (attrRes.data ?? []).map((a) => ({
          attribute: a.attribute,
          value: a.value,
          source: a.source,
          method: a.method,
          confidence: a.confidence === null ? null : Number(a.confidence),
          observedAt: a.observed_at,
          evidence: a.evidence,
          contested: a.contested,
          stale: a.stale,
        })),
        connectors,
      };
    },
  });

  const findWarmPath = tool({
    description:
      "Who in the firm can introduce you to someone. Reach for this by DEFAULT on " +
      "anything shaped like 'does anyone here know X', 'who should make the intro', or " +
      "'how do I get to someone at Acme' — not only after other tools come up empty. " +
      "Returns each target with every teammate who knows them, strongest first, and " +
      "bestAsk: the strongest connector who is not the viewer.",
    inputSchema: z.object({
      needle: z
        .string()
        .optional()
        .describe("A name or company domain to find paths to, e.g. 'stripe.com'."),
      entityIds: z
        .array(z.string().uuid())
        .min(1)
        .max(10)
        .optional()
        .describe("Or specific entityIds from a previous search in this conversation."),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    execute: async ({ needle, entityIds, limit }) => {
      let targetIds = entityIds ?? [];

      if (!targetIds.length && needle) {
        // Unscoped resolution on purpose: this tool only exists in "all" scope, and
        // finding a path to someone requires being able to see them first.
        const { data, error } = await ctx.client.rpc("find_entities_by_contact", {
          needle,
          connector_ids: null,
          match_count: limit,
        });
        if (error) return { error: error.message };
        targetIds = [
          ...new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id)),
        ];
      }
      if (!targetIds.length) {
        return { paths: [], note: "Nobody in the graph matched that." };
      }

      const { data, error } = await ctx.client
        .from("edges")
        .select(
          "strength, source, observed_at, " +
            "contact:entities!edges_to_id_fkey(id, display_name, summary), " +
            "connector:entities!edges_from_id_fkey(id, display_name)",
        )
        .eq("kind", "knows")
        .in("to_id", targetIds)
        .order("strength", { ascending: false, nullsFirst: false })
        .order("observed_at", { ascending: false });
      if (error) return { error: error.message };

      type Row = {
        strength: number | string | null;
        source: string;
        observed_at: string | null;
        contact: { id: string; display_name: string | null; summary: string | null } | null;
        connector: { id: string; display_name: string | null } | null;
      };

      const byTarget = new Map<
        string,
        {
          contact: { entityId: string; name: string | null; summary: string | null };
          connectors: Array<{
            entityId: string;
            name: string | null;
            isYou: boolean;
            strength: number | null;
            lastSeen: string | null;
            sourceMailbox: string;
          }>;
        }
      >();

      // PostgREST types a nested embed as an array — it cannot infer cardinality from
      // the select string — but an explicit `!fkey` hint on a to-one relation returns a
      // single object at runtime. Hence the cast through `unknown`.
      for (const row of (data ?? []) as unknown as Row[]) {
        if (!row.contact || !row.connector) continue;
        const entry = byTarget.get(row.contact.id) ?? {
          contact: {
            entityId: row.contact.id,
            name: row.contact.display_name,
            summary: row.contact.summary,
          },
          connectors: [],
        };
        entry.connectors.push({
          entityId: row.connector.id,
          name: row.connector.display_name,
          isYou: row.connector.id === ctx.viewerEntityId,
          strength: row.strength === null ? null : Number(row.strength),
          lastSeen: row.observed_at,
          sourceMailbox: row.source.replace(/^gmail:/, ""),
        });
        byTarget.set(row.contact.id, entry);
      }

      return {
        paths: [...byTarget.values()].map((entry) => ({
          ...entry,
          // The whole point: who to ask. Excludes the viewer, because "ask yourself"
          // is not an introduction.
          bestAsk: entry.connectors.find((c) => !c.isYou) ?? null,
        })),
      };
    },
  });

  // "mine" scope gets NO cross-member tool at all — structural, not prompted.
  return ctx.scope === "all"
    ? { searchNetwork, lookupByNameOrDomain, listTopConnections, getEntityProfile, findWarmPath }
    : { searchNetwork, lookupByNameOrDomain, listTopConnections, getEntityProfile };
}

export type DawnTools = ReturnType<typeof createDawnTools>;
