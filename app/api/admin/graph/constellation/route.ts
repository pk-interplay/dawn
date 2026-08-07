import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../lib/admin-auth";
import { supabase } from "../../../../../src/lib/supabase";
import { projectTo2D, type ProjectionInput } from "../../../../../src/lib/embedding-projection";
import type { ConstellationResponse, GraphEdge, GraphNode } from "../../../../admin/graph/types";

/**
 * The constellation: every entity projected into its own embedding space, with the
 * relationship graph drawn over it.
 *
 * Service-role client rather than `db`. The route is requireAdmin-gated at the top, and
 * `entities.embedding` is a 1536-float column — reading it as `anon` under a policy that
 * will not stay this permissive is the wrong long-term default. Same reasoning
 * /api/ingest/gmail documents for itself.
 *
 * **Raw embeddings never leave this route.** They are selected, projected, and dropped.
 * Two 2D coordinates per entity is ~60KB for 400 entities; the vectors themselves would
 * be ~5MB, uncached, on every load.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_LIMIT = 600;
const HARD_CAP = 2000;

/**
 * PostgREST returns a pgvector column as a JSON STRING — `"[0.0123,-0.0456,…]"` — not an
 * array, because it serializes unknown types via their Postgres text output and
 * pgvector's text form is a bracketed list. Verified empirically against this project's
 * own database, not assumed.
 */
function parseEmbedding(raw: unknown): number[] | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length !== 1536) return null;
  return value as number[];
}

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const sourceParam = url.searchParams.get("source");
  const limit = Math.min(
    HARD_CAP,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT),
  );

  // PostgREST caps at 1000 rows by default, so the limit must always be explicit.
  let entityQuery = supabase
    .from("entities")
    .select("id, kind, display_name, summary, embedding, auth_user_id, created_at")
    .limit(limit);
  if (kindParam === "person" || kindParam === "organization") {
    entityQuery = entityQuery.eq("kind", kindParam);
  }

  const [entityRes, edgeRes, emailRes] = await Promise.all([
    entityQuery,
    supabase.from("edges").select("from_id, to_id, strength, source, observed_at").eq("kind", "knows"),
    supabase.from("resolved_attributes").select("subject_id, value").eq("attribute", "email"),
  ]);

  if (entityRes.error) return NextResponse.json({ error: entityRes.error.message }, { status: 500 });
  if (edgeRes.error) return NextResponse.json({ error: edgeRes.error.message }, { status: 500 });
  if (emailRes.error) return NextResponse.json({ error: emailRes.error.message }, { status: 500 });

  const entityRows = entityRes.data ?? [];
  const truncated = entityRows.length >= limit;
  const known = new Set(entityRows.map((e) => e.id as string));

  const emailById = new Map<string, string>();
  for (const row of emailRes.data ?? []) {
    const value = row.value;
    if (typeof value === "string") emailById.set(row.subject_id as string, value);
  }

  // Collapse edges to one undirected pair. The unique key is
  // (from_id, to_id, kind, source), so ONE human relationship legitimately produces 2-4
  // rows — both directions times every ingesting mailbox. Drawn raw they stack and read
  // darker and thicker than the relationship actually is.
  interface PairAgg {
    a: string;
    b: string;
    strength: number | null;
    sources: Set<string>;
    observedAt: string | null;
  }
  const pairs = new Map<string, PairAgg>();
  const allSources = new Set<string>();
  const degree = new Map<string, number>();
  const strengthsByEntity = new Map<string, number[]>();
  const latestByEntity = new Map<string, string>();

  for (const row of edgeRes.data ?? []) {
    const from = row.from_id as string;
    const to = row.to_id as string;
    allSources.add(row.source as string);
    // The schema does not prevent a self-edge, and a loop has no line to draw.
    if (from === to) continue;
    if (!known.has(from) || !known.has(to)) continue;

    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}|${b}`;
    const strength = row.strength === null ? null : Number(row.strength);
    const observedAt = (row.observed_at as string | null) ?? null;

    const existing = pairs.get(key);
    if (existing) {
      // max, not sum: aggregating duplicates of the same relationship must not inflate it.
      if (strength !== null && (existing.strength === null || strength > existing.strength)) {
        existing.strength = strength;
      }
      if (observedAt && (!existing.observedAt || observedAt > existing.observedAt)) {
        existing.observedAt = observedAt;
      }
      existing.sources.add(row.source as string);
    } else {
      pairs.set(key, {
        a,
        b,
        strength,
        sources: new Set([row.source as string]),
        observedAt,
      });
    }

    // Most recent interaction seen on either endpoint. NOT an ingest timestamp — see
    // the note on GraphNode.latestActivity.
    if (observedAt) {
      for (const entity of [from, to]) {
        const prev = latestByEntity.get(entity);
        if (!prev || observedAt > prev) latestByEntity.set(entity, observedAt);
      }
    }
  }

  for (const pair of pairs.values()) {
    degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1);
    degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1);
    if (pair.strength !== null) {
      strengthsByEntity.set(pair.a, [...(strengthsByEntity.get(pair.a) ?? []), pair.strength]);
      strengthsByEntity.set(pair.b, [...(strengthsByEntity.get(pair.b) ?? []), pair.strength]);
    }
  }

  // Project.
  const projectionInput: ProjectionInput[] = [];
  const hasEmbedding = new Set<string>();
  for (const row of entityRows) {
    const embedding = parseEmbedding(row.embedding);
    if (!embedding) continue;
    hasEmbedding.add(row.id as string);
    projectionInput.push({ id: row.id as string, embedding });
  }
  const projection = projectTo2D(projectionInput);

  // Which entities are real users. `auth_user_id` is authoritative; the edges.source
  // fallback catches anyone who contributed a mailbox before 0029 stamped them — and is
  // arguably the more meaningful signal, since it means "has actually fed the graph".
  const ingestingMailboxes = new Set(
    [...allSources]
      .filter((s) => s.startsWith("gmail:"))
      .map((s) => s.slice("gmail:".length).toLowerCase()),
  );

  const nodes: GraphNode[] = entityRows.map((row) => {
    const id = row.id as string;
    const point = projection.coords.get(id);
    const strengths = strengthsByEntity.get(id) ?? [];
    const email = emailById.get(id) ?? null;
    return {
      id,
      name: (row.display_name as string | null) ?? null,
      kind: (row.kind as "person" | "organization") ?? "person",
      x: point?.x ?? null,
      y: point?.y ?? null,
      degree: degree.get(id) ?? 0,
      meanStrength: strengths.length
        ? strengths.reduce((s, x) => s + x, 0) / strengths.length
        : null,
      maxStrength: strengths.length ? Math.max(...strengths) : null,
      isUser:
        Boolean(row.auth_user_id) ||
        (email !== null && ingestingMailboxes.has(email.toLowerCase())),
      hasEmbedding: hasEmbedding.has(id),
      hasSummary: Boolean(row.summary),
      latestActivity: latestByEntity.get(id) ?? null,
      email,
    };
  });

  // Opacity is driven by PERCENTILE RANK, not raw strength. network-ingest computes
  // `min(1, (emails + 3*meetings) * 0.5^(ageDays/90))`, so anyone with a couple of
  // recent emails pins at exactly 1.00 — on real data a large share of edges are
  // identical and opacity-from-strength would carry almost no information. Raw strength
  // is still returned, so the choice is auditable in the tooltip.
  const drawn = [...pairs.values()].filter(
    (p) => (sourceParam ? p.sources.has(sourceParam) : true),
  );
  const sorted = [...drawn].filter((p) => p.strength !== null).sort((a, b) => a.strength! - b.strength!);
  const rankOf = new Map<string, number>();
  sorted.forEach((p, i) => {
    rankOf.set(`${p.a}|${p.b}`, sorted.length === 1 ? 1 : i / (sorted.length - 1));
  });

  const edges: GraphEdge[] = drawn.map((p) => ({
    a: p.a,
    b: p.b,
    strength: p.strength,
    rank: rankOf.get(`${p.a}|${p.b}`) ?? 0,
    sources: [...p.sources],
    observedAt: p.observedAt,
    drawable: projection.coords.has(p.a) && projection.coords.has(p.b),
  }));

  const body: ConstellationResponse = {
    generatedAt: new Date().toISOString(),
    projection: {
      method: "pca-block-power-iteration",
      dimensions: 1536,
      placed: projection.coords.size,
      unplaced: entityRows.length - projection.coords.size,
      explainedVariance: projection.explainedVariance,
      axisSeparation: Number.isFinite(projection.axisSeparation)
        ? projection.axisSeparation
        : 999,
      sigma: projection.sigma,
      iterations: projection.iterations,
      converged: projection.converged,
      renormalized: projection.renormalized,
    },
    nodes,
    edges,
    sources: [...allSources].sort(),
    truncated,
  };

  return NextResponse.json(body);
}
