import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The only path into `claims` (SPEC.md §2.1/§5.1). Every claim-producing code
 * path — Gmail ingest, extract_claims, the backfill script, manual admin edits —
 * must call through here rather than `client.from("claims").insert(...)`
 * directly, so confidence clamping and the append-only invariant live in one
 * place. Enforced mechanically by a CI grep check (see .github/workflows/ci.yml)
 * that fails the build on any other `from("claims")` call site.
 */

export type ClaimMethod = "self_reported" | "enriched" | "inferred" | "manual";

export interface ClaimInput {
  subjectId: string;
  attribute: string;
  value: unknown; // JSON-serialisable
  source: string; // 'gmail:<msg_id>' | 'reply:<thread_id>' | 'form' | 'manual' | 'migration:people.<id>'
  method: ClaimMethod;
  confidence: number; // clamped to [0,1] below — never trust a caller or an LLM to have done it
  observedAt: string; // ISO timestamp — when the fact was true, not when we wrote it
  evidence?: string | null;
}

export interface ClaimRow {
  id: number;
  workspace_id: string;
  subject_id: string;
  attribute: string;
  value: unknown;
  source: string;
  method: ClaimMethod;
  confidence: number;
  observed_at: string;
  evidence: string | null;
  superseded_by: number | null;
  created_at: string;
}

function clampConfidence(confidence: number): number {
  if (Number.isNaN(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

function toRow(input: ClaimInput) {
  return {
    subject_id: input.subjectId,
    attribute: input.attribute,
    value: input.value as never,
    source: input.source,
    method: input.method,
    confidence: clampConfidence(input.confidence),
    observed_at: input.observedAt,
    evidence: input.evidence ?? null,
  };
}

/** Insert one claim. Always an insert — the writer never updates a row, and
 * never sets `superseded_by` itself; superseding is a deliberate, separate
 * operation (out of scope for steps 1-3, no caller needs it yet). */
export async function writeClaim(client: SupabaseClient, input: ClaimInput): Promise<ClaimRow> {
  const { data, error } = await client.from("claims").insert(toRow(input)).select().single();
  if (error) throw new Error(`writeClaim failed: ${error.message}`);
  return data as ClaimRow;
}

/**
 * Batch insert. One bad row must not abort the rest — same posture as
 * intro-flow.ts's "one bad send doesn't abort the batch": a Gmail sync touching
 * a hundred contacts shouldn't lose every claim because one had a malformed
 * value. Returns the rows that succeeded and the errors for the ones that didn't,
 * so the caller can decide whether to log, retry, or surface to a review queue.
 */
export async function writeClaims(
  client: SupabaseClient,
  inputs: ClaimInput[],
): Promise<{ written: ClaimRow[]; failed: { input: ClaimInput; error: string }[] }> {
  if (!inputs.length) return { written: [], failed: [] };
  const { data, error } = await client.from("claims").insert(inputs.map(toRow)).select();
  if (!error) return { written: (data ?? []) as ClaimRow[], failed: [] };

  // Batch insert failed outright (e.g. one row violated a check constraint,
  // which fails the whole statement in Postgres) — fall back to inserting one
  // at a time so the good rows still land.
  const written: ClaimRow[] = [];
  const failed: { input: ClaimInput; error: string }[] = [];
  for (const input of inputs) {
    try {
      written.push(await writeClaim(client, input));
    } catch (err) {
      failed.push({ input, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { written, failed };
}

export interface EntityMatchHint {
  email?: string;
  name?: string;
}

/**
 * Resolve an email to the entity that holds it as a live claim, or null.
 *
 * Lifted out of findOrCreateEntity (which still calls it) so callers that must
 * NOT create an entity as a side effect can resolve one — "which entity is the
 * signed-in user" is a lookup, and answering it by creating a duplicate is the
 * bug. It also gives those callers a CI-legal path: the grep guard in
 * .github/workflows/ci.yml fails the build on `from("claims")` anywhere but this
 * file, so every claims read has to be exported from here.
 */
export async function findEntityIdByEmail(
  client: SupabaseClient,
  email: string,
): Promise<string | null> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;

  const { data, error } = await client
    .from("claims")
    .select("subject_id")
    .eq("attribute", "email")
    .is("superseded_by", null)
    .filter("value", "eq", JSON.stringify(normalised))
    .limit(1);
  if (error) throw new Error(`findEntityIdByEmail lookup failed: ${error.message}`);
  return data && data.length > 0 ? (data[0].subject_id as string) : null;
}

/**
 * Resolve a company domain to the organization entity that holds it as a live
 * `domain` claim, or null. The org-side analogue of findEntityIdByEmail: a
 * person is identified automatically by their email, a company by its domain
 * (reconcile-companies.ts materialises `stripe.com` → one organization entity).
 * Same CI-legal read path — every `from("claims")` read lives in this file.
 */
export async function findEntityIdByDomain(
  client: SupabaseClient,
  domain: string,
): Promise<string | null> {
  const normalised = domain.trim().toLowerCase();
  if (!normalised) return null;

  const { data, error } = await client
    .from("claims")
    .select("subject_id")
    .eq("attribute", "domain")
    .is("superseded_by", null)
    .filter("value", "eq", JSON.stringify(normalised))
    .limit(1);
  if (error) throw new Error(`findEntityIdByDomain lookup failed: ${error.message}`);
  return data && data.length > 0 ? (data[0].subject_id as string) : null;
}

/**
 * Find the organization entity for a domain, or create one. Deliberately
 * separate from findOrCreateEntity (which resolves people by email) so the
 * person path stays untouched: a company is resolved on its `domain` claim and
 * nothing else, and two orgs are never merged on name alone — same SPEC §2.4
 * posture as the person side.
 */
export async function findOrCreateOrgByDomain(
  client: SupabaseClient,
  domain: string,
): Promise<{ id: string; created: boolean }> {
  const normalised = domain.trim().toLowerCase();
  const existing = normalised ? await findEntityIdByDomain(client, normalised) : null;
  if (existing) return { id: existing, created: false };

  const { data: created, error: insertError } = await client
    .from("entities")
    .insert({ kind: "organization" })
    .select("id")
    .single();
  if (insertError) throw new Error(`findOrCreateOrgByDomain insert failed: ${insertError.message}`);
  return { id: created.id as string, created: true };
}

/**
 * Find an entity by email (the only basis used for automatic resolution —
 * SPEC §2.4: never hard-merge on name alone) or create one. Two investors
 * named Chen at different funds must not collapse into one entity just because
 * ingest saw the same display name; email is the one signal reliable enough to
 * resolve automatically. A name-only hint with no email match creates a new
 * entity rather than guessing — candidate matches on weaker signals belong in
 * `entity_links` for a human to confirm, not in this function.
 */
export async function findOrCreateEntity(
  client: SupabaseClient,
  opts: { kind: "person" | "organization"; matchHint?: EntityMatchHint },
): Promise<string> {
  const email = opts.matchHint?.email?.trim().toLowerCase();
  if (email) {
    const existing = await findEntityIdByEmail(client, email);
    if (existing) return existing;
  }

  const { data: created, error: insertError } = await client
    .from("entities")
    .insert({ kind: opts.kind })
    .select("id")
    .single();
  if (insertError) throw new Error(`findOrCreateEntity insert failed: ${insertError.message}`);
  return created.id as string;
}

/**
 * Recompute `entities.display_name` from `resolved_attributes`. The only
 * writer of that denormalised column — SPEC §2.1's "never written by hand"
 * rule: it can always be rebuilt from claims and can never disagree with them.
 * Prefers a `name` claim (self-reported or the most-recently-observed display
 * name seen on an email) over falling back to the `email` claim.
 */
export async function projectDisplayName(client: SupabaseClient, entityId: string): Promise<string | null> {
  const { data, error } = await client
    .from("resolved_attributes")
    .select("attribute, value")
    .eq("subject_id", entityId)
    .in("attribute", ["name", "email"]);
  if (error) throw new Error(`projectDisplayName lookup failed: ${error.message}`);

  const byAttr = new Map((data ?? []).map((row) => [row.attribute as string, row.value]));
  const displayName = (byAttr.get("name") ?? byAttr.get("email") ?? null) as string | null;

  const { error: updateError } = await client
    .from("entities")
    .update({ display_name: displayName })
    .eq("id", entityId);
  if (updateError) throw new Error(`projectDisplayName write failed: ${updateError.message}`);
  return displayName;
}
