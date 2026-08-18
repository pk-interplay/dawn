import type { SupabaseClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import {
  findOrCreateOrgByDomain,
  projectDisplayName,
  writeClaim,
} from "./claims";
import { domainOf, GENERIC_DOMAINS } from "./domains";
import { enrichCompany } from "./enrich-company";

/**
 * Company reconciliation (the feature: promote a work-email domain to a first-class
 * organization entity once enough of the network is at it, then enrich it via Exa).
 *
 * A company is not its own table — it is an `entities` row with kind='organization',
 * identified by a `domain` claim, the org-side mirror of a person identified by an
 * `email` claim (claims.ts). So this pass is pure claims/edges bookkeeping and stays
 * inside every existing invariant: claims go through writeClaim, edges through the
 * idempotent upsert network-ingest already uses, RLS untouched.
 *
 * Idempotent and cheap to re-run (it is a daily cron): orgs de-dupe on their domain
 * claim, edges on their unique key, and Exa is only called for an org that has no
 * fresh `exa:` claim — so the scheduled run does not re-pay for companies it already
 * enriched.
 */

/** Strictly more than 5 people at a domain promotes it to a company (the ask). */
export const COMPANY_MIN_PEOPLE = 6;

/** Don't re-pay Exa for a company enriched within this window. */
const ENRICH_TTL_DAYS = 30;

/**
 * At most this many Exa+Haiku+embedding enrichments per run. The daily cron plus
 * the 30-day TTL means the backlog drains over subsequent runs; without a cap,
 * one run tried to enrich EVERY qualifying domain sequentially and was killed by
 * the platform partway, every day, forever — company reconciliation had likely
 * never completed a pass.
 */
const MAX_ENRICHMENTS_PER_RUN = 10;

/** Concurrent domains in flight. Per-domain internals stay sequential (claim →
 *  edges → enrich ordering matters); this only overlaps separate domains. */
const DOMAIN_CONCURRENCY = 3;

export interface ReconcileSummary {
  domainsConsidered: number;
  companiesCreated: number;
  companiesEnriched: number;
  edgesWritten: number;
  skippedEnrichment: number;
  failures: string[];
  /** True when the deadline or the enrichment cap left work for the next run. */
  truncated: boolean;
}

/**
 * Bucket resolved email rows into domain → set of distinct person entity ids,
 * dropping malformed addresses and generic free-mail domains. Pure and exported so
 * the threshold logic is unit-testable without a Supabase client.
 *
 * Input rows come from `resolved_attributes` (attribute='email'), which is already
 * distinct-on subject_id, so each entity contributes at most one email — but the Set
 * makes the "distinct people" guarantee explicit rather than assumed.
 */
export function bucketPeopleByDomain(
  rows: { subject_id: string; value: unknown }[],
): Map<string, Set<string>> {
  const byDomain = new Map<string, Set<string>>();
  for (const row of rows) {
    if (typeof row.value !== "string") continue;
    const domain = domainOf(row.value);
    if (!domain || GENERIC_DOMAINS.has(domain)) continue;
    const set = byDomain.get(domain) ?? new Set<string>();
    set.add(row.subject_id);
    byDomain.set(domain, set);
  }
  return byDomain;
}

/** Provisional display name from a domain (e.g. "stripe.com" → "Stripe"); Exa overwrites it. */
export function nameFromDomain(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Has this org been enriched by Exa within the TTL? Reads the view, not `claims` (CI-legal). */
async function isFreshlyEnriched(client: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await client
    .from("resolved_attributes")
    .select("source, observed_at")
    .eq("subject_id", orgId);
  if (error) throw new Error(`isFreshlyEnriched lookup failed: ${error.message}`);

  const cutoff = Date.now() - ENRICH_TTL_DAYS * 24 * 60 * 60 * 1000;
  return (data ?? []).some(
    (row) =>
      typeof row.source === "string" &&
      row.source.startsWith("exa:") &&
      Date.parse(row.observed_at as string) >= cutoff,
  );
}

export async function reconcileCompanies(
  client: SupabaseClient,
  opts: { deadline?: number; maxEnrichments?: number } = {},
): Promise<ReconcileSummary> {
  const maxEnrichments = opts.maxEnrichments ?? MAX_ENRICHMENTS_PER_RUN;
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;

  // Paged, like claims.ts loadEmailIndex. An unpaged select is silently capped at
  // PostgREST's 1000-row default, which meant reconciliation only ever SAW the
  // first thousand addresses in the graph — real companies past that point were
  // never promoted, with no error anywhere.
  const emailRows: { subject_id: string; value: unknown }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("resolved_attributes")
      .select("subject_id, value")
      .eq("attribute", "email")
      .order("subject_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reconcileCompanies email lookup failed: ${error.message}`);
    emailRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const byDomain = bucketPeopleByDomain(emailRows);

  const summary: ReconcileSummary = {
    domainsConsidered: byDomain.size,
    companiesCreated: 0,
    companiesEnriched: 0,
    edgesWritten: 0,
    skippedEnrichment: 0,
    failures: [],
    truncated: false,
  };

  // Synchronous check-and-increment (single-threaded between awaits), so the cap
  // holds even with domains in flight concurrently.
  let enrichmentsStarted = 0;

  const limit = pLimit(DOMAIN_CONCURRENCY);
  const processDomain = async (domain: string, people: Set<string>) => {
    if (outOfTime()) {
      summary.truncated = true;
      return;
    }

    try {
      const { id: orgId, created } = await findOrCreateOrgByDomain(client, domain);

      if (created) {
        const now = new Date().toISOString();
        // The domain claim is the org's identity handle — how findOrCreateOrgByDomain
        // resolves it next time. The name is provisional until Exa supplies a real one.
        await writeClaim(client, {
          subjectId: orgId,
          attribute: "domain",
          value: domain,
          source: `domain:${domain}`,
          method: "inferred",
          confidence: 1,
          observedAt: now,
        });
        await writeClaim(client, {
          subjectId: orgId,
          attribute: "name",
          value: nameFromDomain(domain),
          source: `domain:${domain}`,
          method: "inferred",
          confidence: 0.4,
          observedAt: now,
        });
        await projectDisplayName(client, orgId);
        summary.companiesCreated += 1;
      }

      // Link every person at the domain to the org. Same idempotent upsert key as
      // network-ingest's `knows` edges, so re-runs never duplicate.
      const observedAt = new Date().toISOString();
      for (const personId of people) {
        const { error: edgeError } = await client.from("edges").upsert(
          {
            from_id: personId,
            to_id: orgId,
            kind: "works_at",
            strength: null,
            source: `domain:${domain}`,
            observed_at: observedAt,
          },
          { onConflict: "from_id,to_id,kind,source" },
        );
        if (edgeError) throw new Error(`edge upsert failed: ${edgeError.message}`);
        summary.edgesWritten += 1;
      }

      // Enrich at most once per TTL — Exa costs money and a daily cron must not re-pay.
      if (await isFreshlyEnriched(client, orgId)) {
        summary.skippedEnrichment += 1;
      } else if (enrichmentsStarted >= maxEnrichments) {
        // Cap reached: the org and its edges still stand; enrichment waits for a
        // later run. Reported, never silent.
        summary.skippedEnrichment += 1;
        summary.truncated = true;
      } else {
        enrichmentsStarted += 1;
        const result = await enrichCompany(client, { entityId: orgId, domain });
        if (result.enriched) summary.companiesEnriched += 1;
        else summary.skippedEnrichment += 1; // no_api_key — org + edges still stand
      }
    } catch (err) {
      // One bad company must not abort the batch — same posture as writeClaims and
      // network-ingest: a single domain's failure is logged, the rest proceed.
      summary.failures.push(`${domain}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await Promise.all(
    [...byDomain.entries()]
      .filter(([, people]) => people.size >= COMPANY_MIN_PEOPLE)
      .map(([domain, people]) => limit(() => processDomain(domain, people))),
  );

  if (summary.truncated) {
    console.info(
      `[reconcile-companies] run truncated (deadline or enrichment cap); remaining domains complete on later runs`,
    );
  }
  return summary;
}
