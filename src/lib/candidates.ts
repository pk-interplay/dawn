import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candidate, Person } from "./types";
import type { CalibrationExample, HistoryExample, PreferenceExample } from "./rerank";

const CANDIDATE_LIMIT = 10;
// The vector RPCs can't filter by cohort/paused (their return signature is a fixed
// 7-column list, and they're already overloaded across 0002/0004 — see the
// disambiguating comment in /api/find). So we over-fetch and filter in code; this
// multiplier is the headroom that keeps filtering from starving the shortlist.
const CANDIDATE_OVERFETCH = 3;
const CALIBRATION_LIMIT = 8;
const PREFERENCE_LIMIT = 20;
const HISTORY_LIMIT = 5;

export async function fetchRejectedIds(client: SupabaseClient, personId: string): Promise<Set<string>> {
  const { data, error } = await client
    .from("matches")
    .select("person_a_id, person_b_id")
    .eq("status", "rejected")
    .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((m) => (m.person_a_id === personId ? m.person_b_id : m.person_a_id)));
}

/**
 * Candidates that are ineligible regardless of similarity.
 *
 * Two exclusions, both of which the vector search can't express:
 *
 * - **Cross-cohort.** Seeded fixtures and real members never meet each other, so a
 *   real colleague can't be offered an intro to a persona with an @example.com
 *   address, and the synthetic sandbox keeps working unchanged.
 * - **Paused.** `paused` previously only stopped someone being a *subject* of
 *   matching; they could still be suggested to others. That was survivable while
 *   only person A was ever emailed, but under double opt-in person B receives an
 *   opt-in email — so a member who explicitly asked Dawn to stop would have been
 *   emailed anyway, as someone else's suggested match.
 */
async function fetchIneligibleIds(
  client: SupabaseClient,
  ids: string[],
  isSynthetic: boolean,
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await client
    .from("people")
    .select("id, paused, is_synthetic")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return new Set(
    (data ?? [])
      .filter((p) => p.paused === true || p.is_synthetic !== isSynthetic)
      .map((p) => p.id as string),
  );
}

export async function fetchCandidates(client: SupabaseClient, person: Person) {
  const overfetch = CANDIDATE_LIMIT * CANDIDATE_OVERFETCH;
  const [wantsFilled, offersWanted, rejectedIds] = await Promise.all([
    client.rpc("match_people_by_offering", {
      query_embedding: person.embedding_looking_for,
      exclude_id: person.id,
      match_count: overfetch,
      query_tags_embedding: person.embedding_tags ?? null,
    }),
    client.rpc("match_people_by_looking_for", {
      query_embedding: person.embedding_offering,
      exclude_id: person.id,
      match_count: overfetch,
      query_tags_embedding: person.embedding_tags ?? null,
    }),
    fetchRejectedIds(client, person.id),
  ]);
  if (wantsFilled.error) throw new Error(wantsFilled.error.message);
  if (offersWanted.error) throw new Error(offersWanted.error.message);

  const merged = new Map<string, Candidate>();
  for (const row of wantsFilled.data ?? []) {
    merged.set(row.id, { ...row, surfaced_via: "a_offers_b_wants" });
  }
  let mutualCount = 0;
  for (const row of offersWanted.data ?? []) {
    const existing = merged.get(row.id);
    if (existing) {
      existing.surfaced_via = "mutual";
      existing.similarity = Math.max(existing.similarity, row.similarity);
      mutualCount++;
    } else {
      merged.set(row.id, { ...row, surfaced_via: "b_offers_a_wants" });
    }
  }

  const beforeExclusion = [...merged.values()];
  const ineligibleIds = await fetchIneligibleIds(
    client,
    beforeExclusion.map((c) => c.id),
    person.is_synthetic === true,
  );

  const excludedRejectedCount = beforeExclusion.filter((c) => rejectedIds.has(c.id)).length;
  const excludedIneligibleCount = beforeExclusion.filter((c) => ineligibleIds.has(c.id)).length;
  const candidates = beforeExclusion
    .filter((c) => !rejectedIds.has(c.id) && !ineligibleIds.has(c.id))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CANDIDATE_LIMIT);

  return {
    candidates,
    wantsFilledCount: wantsFilled.data?.length ?? 0,
    offersWantedCount: offersWanted.data?.length ?? 0,
    mutualCount,
    excludedRejectedCount,
    excludedIneligibleCount,
  };
}

export async function fetchCalibration(client: SupabaseClient, personId: string): Promise<CalibrationExample[]> {
  const { data: saved, error } = await client
    .from("matches")
    .select("person_a_id, person_b_id, status, rationale")
    .neq("status", "suggested")
    .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
    .order("created_at", { ascending: false })
    .limit(CALIBRATION_LIMIT);
  if (error) throw new Error(error.message);
  if (!saved?.length) return [];

  const otherIds = saved.map((m) => (m.person_a_id === personId ? m.person_b_id : m.person_a_id));
  const { data: others, error: othersError } = await client.from("people").select("id, name").in("id", otherIds);
  if (othersError) throw new Error(othersError.message);

  const nameById = new Map((others ?? []).map((p) => [p.id, p.name]));
  return saved.map((m) => ({
    other_name: nameById.get(m.person_a_id === personId ? m.person_b_id : m.person_a_id) ?? "unknown",
    status: m.status,
    rationale: m.rationale,
  }));
}

/**
 * Active preferences this person has stated or that were inferred from their
 * replies. Ordered by confidence so the most explicit beliefs survive the cap.
 */
export async function fetchPreferences(
  client: SupabaseClient,
  personId: string,
): Promise<PreferenceExample[]> {
  const { data, error } = await client
    .from("person_preferences")
    .select("kind, value, source, confidence")
    .eq("person_id", personId)
    .eq("active", true)
    .order("confidence", { ascending: false })
    .limit(PREFERENCE_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({
    kind: p.kind as string,
    value: p.value as string,
    source: p.source as string,
    confidence: Number(p.confidence),
  }));
}

/**
 * The last few things this person actually wrote back to Dawn. Reads the stored
 * `parsed` summaries rather than raw bodies: they're already condensed, and it
 * keeps arbitrary inbound email text out of the matching prompt.
 *
 * Two-step (conversations, then their messages) because `participants` is a jsonb
 * array and filtering it through an embedded join is far more fragile than a
 * containment query followed by an `in`.
 */
export async function fetchRecentHistory(
  client: SupabaseClient,
  personId: string,
  limit = HISTORY_LIMIT,
): Promise<HistoryExample[]> {
  const { data: convos, error: cErr } = await client
    .from("conversations")
    .select("id, purpose")
    // Must be a JSON *string*. Handed a JS array, supabase-js builds a Postgres
    // array literal (`{"[object Object]"}`) instead of jsonb, and Postgres rejects
    // it with "invalid input syntax for type json".
    .contains("participants", JSON.stringify([{ person_id: personId }]));
  if (cErr) throw new Error(cErr.message);
  if (!convos?.length) return [];

  const purposeById = new Map(convos.map((c) => [c.id as string, c.purpose as string]));

  const { data: msgs, error: mErr } = await client
    .from("messages")
    .select("conversation_id, parsed, created_at")
    .in(
      "conversation_id",
      convos.map((c) => c.id),
    )
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (mErr) throw new Error(mErr.message);

  return (msgs ?? [])
    .map((m) => {
      const parsed = (m.parsed ?? {}) as { summary?: string };
      return {
        when: String(m.created_at).slice(0, 10),
        purpose: purposeById.get(m.conversation_id as string) ?? "unknown",
        said: parsed.summary ?? "",
      };
    })
    .filter((h) => h.said.length > 0);
}
