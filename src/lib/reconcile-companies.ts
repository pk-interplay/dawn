import type { SupabaseClient } from "@supabase/supabase-js";
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

export interface ReconcileSummary {
  domainsConsidered: number;
  companiesCreated: number;
  companiesEnriched: number;
  edgesWritten: number;
  skippedEnrichment: number;
  failures: string[];
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

export async function reconcileCompanies(client: SupabaseClient): Promise<ReconcileSummary> {
  const { data: emailRows, error } = await client
    .from("resolved_attributes")
    .select("subject_id, value")
    .eq("attribute", "email");
  if (error) throw new Error(`reconcileCompanies email lookup failed: ${error.message}`);

  const byDomain = bucketPeopleByDomain(emailRows ?? []);

  const summary: ReconcileSummary = {
    domainsConsidered: byDomain.size,
    companiesCreated: 0,
    companiesEnriched: 0,
    edgesWritten: 0,
    skippedEnrichment: 0,
    failures: [],
  };

  for (const [domain, people] of byDomain.entries()) {
    if (people.size < COMPANY_MIN_PEOPLE) continue;

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
      } else {
        const result = await enrichCompany(client, { entityId: orgId, domain });
        if (result.enriched) summary.companiesEnriched += 1;
        else summary.skippedEnrichment += 1; // no_api_key — org + edges still stand
      }
    } catch (err) {
      // One bad company must not abort the batch — same posture as writeClaims and
      // network-ingest: a single domain's failure is logged, the rest proceed.
      summary.failures.push(`${domain}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
