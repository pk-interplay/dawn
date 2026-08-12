import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LIST_FIELDS,
  SCALAR_FIELDS,
  type ListField,
  type ProfilePatch,
  type ScalarField,
} from "./profile-fields";
import {
  listLiveClaims,
  projectDisplayName,
  supersedeClaims,
  writeClaim,
  type ClaimRow,
} from "./claims";

/**
 * Reading and editing your own profile.
 *
 * ## Why this is not an UPDATE
 *
 * There is no profile row to edit. A profile is a projection of claims (SPEC §2.1), so
 * "change my headline" is: write a new `self_reported` claim, and point the claim it
 * replaces at it. The old value stays on the record with a successor — which is the
 * whole reason the model is append-only, and why the admin review queue can still show
 * that Dawn once inferred something different from what you now say.
 *
 * `method: "self_reported"` at confidence 1.0 is the strongest thing this system can
 * hold, and `resolved_attributes` ranks self_reported above every other method before
 * it looks at confidence. That is deliberate: what you say about yourself outranks what
 * the model inferred about you from your subject lines, permanently and by construction.
 * It is also why onboarding's confirmed draft is written as `inferred` and not this —
 * see profile-claims.ts.
 *
 * ## Scalars vs. lists
 *
 * Scalars (headline, bio, …) hold one live claim: writing a new one supersedes the old.
 * Lists (goals, asks, expertise, interests) hold one claim PER ITEM, so an edit is a
 * diff — added items are inserted, removed items are retracted, untouched items keep
 * their original claim and its original observed_at. Editing your asks therefore does
 * not reset the age of the ones you left alone.
 *
 * Reads go through `listLiveClaims` rather than `resolved_attributes`, because that view
 * is `distinct on (subject_id, attribute)` and would hand back exactly one goal however
 * many you have. `buildPersonLikeView` has that bug; it is a read path for rerank() and
 * is left alone here, but this is the file to trust for what the user actually holds.
 */

export * from "./profile-fields";

export interface EditableProfile {
  entityId: string;
  name: string | null;
  email: string | null;
  scalars: Record<ScalarField, string>;
  lists: Record<ListField, string[]>;
  /** Which fields came from the user rather than from inference — the form flags these. */
  selfReported: Record<string, boolean>;
}

const ALL_FIELDS = [...SCALAR_FIELDS, ...LIST_FIELDS] as readonly string[];

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Pick the winner among live claims for a scalar, mirroring `resolved_attributes`. */
function bestScalar(rows: ClaimRow[]): ClaimRow | null {
  return (
    [...rows].sort((a, b) => {
      const self = Number(b.method === "self_reported") - Number(a.method === "self_reported");
      if (self) return self;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.observed_at.localeCompare(a.observed_at);
    })[0] ?? null
  );
}

export async function loadEditableProfile(
  client: SupabaseClient,
  entityId: string,
): Promise<EditableProfile> {
  const rows = await listLiveClaims(client, entityId, [...ALL_FIELDS, "email"]);

  const byAttr = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    byAttr.set(row.attribute, [...(byAttr.get(row.attribute) ?? []), row]);
  }

  const { data: entity, error } = await client
    .from("entities")
    .select("id, display_name")
    .eq("id", entityId)
    .single();
  if (error) throw new Error(`loadEditableProfile entity lookup failed: ${error.message}`);

  const scalars = {} as Record<ScalarField, string>;
  const selfReported: Record<string, boolean> = {};
  for (const field of SCALAR_FIELDS) {
    const winner = bestScalar(byAttr.get(field) ?? []);
    scalars[field] = asText(winner?.value);
    selfReported[field] = winner?.method === "self_reported";
  }

  const lists = {} as Record<ListField, string[]>;
  for (const field of LIST_FIELDS) {
    const claims = byAttr.get(field) ?? [];
    lists[field] = claims.map((row) => asText(row.value)).filter(Boolean);
    selfReported[field] = claims.length > 0 && claims.every((row) => row.method === "self_reported");
  }

  return {
    entityId,
    name: (entity.display_name as string | null) ?? null,
    email: asText(bestScalar(byAttr.get("email") ?? [])?.value) || null,
    scalars,
    lists,
    selfReported,
  };
}

export interface ProfileEditResult {
  /** Field → what it now holds, for the agent to echo back and the form to re-render. */
  changed: Record<string, string | string[]>;
  written: number;
  retired: number;
}

/**
 * Apply a patch. Returns only what actually changed, so a "save" that moved nothing
 * writes nothing — re-submitting the form must not append a duplicate claim per field
 * and reset every observed_at.
 *
 * `source` names who is doing the editing (`profile-form` or `chat`), because "did the
 * agent change this or did I?" is a question the review queue has to be able to answer.
 */
export async function applyProfilePatch(
  client: SupabaseClient,
  opts: {
    entityId: string;
    patch: ProfilePatch;
    source: "profile-form" | "chat";
    /** Verbatim quote of what the user said, when there is one — chat has it, forms don't. */
    evidence?: string | null;
  },
): Promise<ProfileEditResult> {
  const current = await loadEditableProfile(client, opts.entityId);
  const rows = await listLiveClaims(client, opts.entityId, ALL_FIELDS);
  const observedAt = new Date().toISOString();

  const base = {
    subjectId: opts.entityId,
    source: opts.source,
    method: "self_reported" as const,
    // The user stating a fact about themselves is the ceiling of what this graph can
    // know. Anything less would let an old inference outrank them on confidence.
    confidence: 1,
    observedAt,
    evidence: opts.evidence ?? null,
  };

  const changed: ProfileEditResult["changed"] = {};
  let written = 0;
  let retired = 0;

  for (const field of SCALAR_FIELDS) {
    const next = opts.patch[field];
    if (next === undefined || next === current.scalars[field]) continue;

    const live = rows.filter((row) => row.attribute === field).map((row) => row.id);
    // Clearing a field is a retraction with no successor; changing it is a correction,
    // so the old claim gets a pointer to the one that replaced it.
    if (next) {
      const claim = await writeClaim(client, { ...base, attribute: field, value: next });
      written += 1;
      retired += await supersedeClaims(client, live, claim.id);
    } else {
      retired += await supersedeClaims(client, live);
    }
    changed[field] = next;
  }

  for (const field of LIST_FIELDS) {
    const next = opts.patch[field];
    if (next === undefined) continue;

    // Case-insensitive, so re-typing "Fintech" over "fintech" is not a change. Dedupes
    // too: one claim per item means a repeated item would be a duplicate claim.
    const seen = new Set<string>();
    const wanted = next.filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const wantedKeys = new Set(wanted.map((item) => item.toLowerCase()));

    const live = rows.filter((row) => row.attribute === field);
    const liveKeys = new Set(live.map((row) => asText(row.value).toLowerCase()));

    const additions = wanted.filter((item) => !liveKeys.has(item.toLowerCase()));
    const removals = live.filter((row) => !wantedKeys.has(asText(row.value).toLowerCase()));
    if (!additions.length && !removals.length) continue;

    for (const item of additions) {
      await writeClaim(client, { ...base, attribute: field, value: item });
      written += 1;
    }
    retired += await supersedeClaims(client, removals.map((row) => row.id));
    changed[field] = wanted;
  }

  // display_name is projected, never written by hand (claims.ts). Nothing above touches
  // `name`, but a profile edit is a cheap and safe moment to re-run the projection.
  if (written || retired) await projectDisplayName(client, opts.entityId);

  return { changed, written, retired };
}

/**
 * Re-summarise and re-embed after an edit.
 *
 * Separate from `applyProfilePatch` and always caught: `match_entities` skips rows with
 * a null embedding, so a stale one makes you findable under your OLD description — bad,
 * but nowhere near bad enough to fail the save the user already watched succeed. Same
 * posture as the onboarding confirm route.
 */
export async function refreshProfileEmbedding(
  client: SupabaseClient,
  entityId: string,
): Promise<boolean> {
  try {
    const { summarizeEntity } = await import("./summarize-entity");
    await summarizeEntity(client, entityId);
    return true;
  } catch (err) {
    console.error("[profile-edit] summarizeEntity failed:", err);
    return false;
  }
}
