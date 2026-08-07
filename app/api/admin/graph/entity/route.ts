import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../lib/admin-auth";
import { supabase } from "../../../../../src/lib/supabase";
import type { EntityDetailResponse } from "../../../../admin/graph/types";

/**
 * One entity, with every attribute's provenance.
 *
 * This is SPEC §6's "Entity view": every attribute with source, method, confidence,
 * observed_at, and whether it is contested or stale. `evidence` comes back with each row
 * because §6 is explicit that a row without it makes approving into rubber-stamping.
 *
 * Reads `resolved_attributes`, never the claims table directly — the CI grep guard
 * confines that access to src/lib/claims.ts, and the view is the resolved answer anyway.
 *
 * KNOWN LIMITATION: the view is `distinct on (subject_id, attribute)`, so a contested
 * attribute shows only the WINNING claim. The operator sees "contested" but not what it
 * conflicts with, which is what they would need to adjudicate. Reading the losers needs a
 * new exported function in claims.ts (`listClaimsForAttribute`); deliberately deferred.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const [entityRes, attrRes, edgeRes, linkRes] = await Promise.all([
    supabase
      .from("entities")
      .select("id, kind, display_name, summary, embedding, auth_user_id, created_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("resolved_attributes")
      .select("attribute, value, source, method, confidence, observed_at, evidence, contested, stale")
      .eq("subject_id", id),
    supabase
      .from("edges")
      .select(
        "from_id, to_id, strength, source, observed_at, " +
          "from_entity:entities!edges_from_id_fkey(id, display_name), " +
          "to_entity:entities!edges_to_id_fkey(id, display_name)",
      )
      .or(`from_id.eq.${id},to_id.eq.${id}`)
      .order("strength", { ascending: false, nullsFirst: false }),
    supabase
      .from("entity_links")
      .select(
        "left_id, right_id, basis, confidence, status, " +
          "left_entity:entities!entity_links_left_id_fkey(id, display_name), " +
          "right_entity:entities!entity_links_right_id_fkey(id, display_name)",
      )
      .or(`left_id.eq.${id},right_id.eq.${id}`),
  ]);

  if (entityRes.error) return NextResponse.json({ error: entityRes.error.message }, { status: 500 });
  if (!entityRes.data) return NextResponse.json({ error: "No such entity" }, { status: 404 });
  if (attrRes.error) return NextResponse.json({ error: attrRes.error.message }, { status: 500 });
  if (edgeRes.error) return NextResponse.json({ error: edgeRes.error.message }, { status: 500 });

  // A PostgREST embed on a to-one relation is typed as an array but returns an object.
  type Named = { id: string; display_name: string | null } | null;
  type EdgeRow = {
    from_id: string;
    to_id: string;
    strength: number | string | null;
    source: string;
    observed_at: string | null;
    from_entity: Named;
    to_entity: Named;
  };
  type LinkRow = {
    left_id: string;
    right_id: string;
    basis: string;
    confidence: number | string | null;
    status: string;
    left_entity: Named;
    right_entity: Named;
  };

  const edges = ((edgeRes.data ?? []) as unknown as EdgeRow[]).map((row) => {
    const outgoing = row.from_id === id;
    const other = outgoing ? row.to_entity : row.from_entity;
    return {
      other: { id: other?.id ?? (outgoing ? row.to_id : row.from_id), name: other?.display_name ?? null },
      strength: row.strength === null ? null : Number(row.strength),
      source: row.source,
      observedAt: row.observed_at,
      direction: (outgoing ? "out" : "in") as "out" | "in",
    };
  });

  // entity_links is optional context; a failure here should not blank the whole panel.
  const links = linkRes.error
    ? []
    : ((linkRes.data ?? []) as unknown as LinkRow[]).map((row) => {
        const other = row.left_id === id ? row.right_entity : row.left_entity;
        return {
          other: {
            id: other?.id ?? (row.left_id === id ? row.right_id : row.left_id),
            name: other?.display_name ?? null,
          },
          basis: row.basis,
          confidence: row.confidence === null ? null : Number(row.confidence),
          status: row.status,
        };
      });

  const body: EntityDetailResponse = {
    entity: {
      id: entityRes.data.id as string,
      name: (entityRes.data.display_name as string | null) ?? null,
      kind: entityRes.data.kind as string,
      summary: (entityRes.data.summary as string | null) ?? null,
      hasEmbedding: entityRes.data.embedding !== null,
      isUser: Boolean(entityRes.data.auth_user_id),
      createdAt: (entityRes.data.created_at as string | null) ?? null,
    },
    attributes: (attrRes.data ?? []).map((a) => ({
      attribute: a.attribute as string,
      value: a.value,
      source: a.source as string,
      method: a.method as string,
      confidence: a.confidence === null ? null : Number(a.confidence),
      observedAt: (a.observed_at as string | null) ?? null,
      evidence: (a.evidence as string | null) ?? null,
      contested: Boolean(a.contested),
      stale: Boolean(a.stale),
    })),
    edges,
    links,
  };

  return NextResponse.json(body);
}
