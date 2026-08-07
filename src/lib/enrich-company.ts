import type { SupabaseClient } from "@supabase/supabase-js";
import { writeClaims, type ClaimInput } from "./claims";
import { summarizeEntity } from "./summarize-entity";

/**
 * Programmatic company enrichment via the Exa `/answer` API (reconcile-companies.ts
 * calls this once a domain crosses the people threshold and an organization entity
 * exists for it).
 *
 * Exa's `/answer` with an `outputSchema` returns a structured object plus the web
 * `citations` it drew from. Each populated field becomes one `enriched` claim — the
 * same claim model everything else in the graph uses — with the top citation stored
 * as the claim's evidence, so the review queue can see *why* we believe "Stripe is a
 * payments company" (SPEC §2.1: enriched claims are inferred, not asserted, and carry
 * their source). We then run summarizeEntity() so the org gets a summary + embedding
 * and is semantically matchable like a person.
 *
 * Degrades gracefully with no EXA_API_KEY (returns { enriched: false }), the same
 * posture synthesizeProfile takes on a missing ANTHROPIC_API_KEY — reconciliation
 * still creates the org and its edges, it just carries no Exa facts yet.
 */

const EXA_ANSWER_URL = "https://api.exa.ai/answer";

/** Exa-sourced facts are web-inferred, not self-reported — mid confidence, contestable. */
const ENRICHED_CONFIDENCE = 0.6;

/**
 * Maps each Exa output field to the claim attribute it becomes. Attribute names match
 * the person-side vocabulary where it overlaps (`name`), and stay snake_case for the
 * rest so summarizeEntity's prompt reads them uniformly.
 */
const FIELD_TO_ATTRIBUTE: Record<string, string> = {
  name: "name",
  description: "description",
  industry: "industry",
  headquarters: "hq",
  employeeRange: "employee_range",
  foundedYear: "founded_year",
  website: "website",
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The company's common name, e.g. 'Stripe'" },
    description: { type: "string", description: "1-2 sentences on what the company does" },
    industry: { type: "string", description: "Primary industry or sector" },
    headquarters: { type: "string", description: "Headquarters location, city and country" },
    employeeRange: { type: "string", description: "Approximate headcount band, e.g. '1000-5000'" },
    foundedYear: { type: "number", description: "Year the company was founded" },
    website: { type: "string", description: "Primary marketing website URL" },
  },
  additionalProperties: false,
} as const;

interface ExaCitation {
  title?: string;
  url?: string;
}

interface ExaAnswerResponse {
  answer?: Record<string, unknown>;
  citations?: ExaCitation[];
  costDollars?: { total?: number };
}

export type EnrichCompanyResult =
  | { enriched: false; reason: "no_api_key"; claimsWritten: 0 }
  | { enriched: true; claimsWritten: number; costDollars: number | null };

/** One-line provenance stored on every enriched claim, so the review queue can trace it. */
function evidenceLine(domain: string, citations: ExaCitation[] | undefined): string {
  const top = citations?.find((c) => c.url);
  const cite = top ? ` Top source: ${top.title ?? top.url} (${top.url})` : "";
  return `Enriched by Exa /answer for ${domain}.${cite}`;
}

export async function enrichCompany(
  client: SupabaseClient,
  opts: { entityId: string; domain: string },
): Promise<EnrichCompanyResult> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return { enriched: false, reason: "no_api_key", claimsWritten: 0 };

  const domain = opts.domain.trim().toLowerCase();

  const resp = await fetch(EXA_ANSWER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query:
        `Give a concise company profile for the organization whose primary web domain is ` +
        `"${domain}": its common name, what it does, industry, headquarters, approximate ` +
        `headcount, founding year, and primary website. If a field is genuinely unknown, omit it.`,
      text: false,
      outputSchema: OUTPUT_SCHEMA,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Exa /answer failed for ${domain}: ${resp.status} ${resp.statusText} ${body}`.trim());
  }

  const data = (await resp.json()) as ExaAnswerResponse;
  // `answer` may arrive parsed or as a JSON string depending on the model path.
  const answer: Record<string, unknown> =
    typeof data.answer === "string" ? safeParse(data.answer) : (data.answer ?? {});

  const observedAt = new Date().toISOString();
  const evidence = evidenceLine(domain, data.citations);

  const inputs: ClaimInput[] = [];
  for (const [field, attribute] of Object.entries(FIELD_TO_ATTRIBUTE)) {
    const value = answer[field];
    // Skip absent / empty fields — an empty claim is worse than no claim.
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    inputs.push({
      subjectId: opts.entityId,
      attribute,
      value: typeof value === "string" ? value.trim() : value,
      source: `exa:${domain}`,
      method: "enriched",
      confidence: ENRICHED_CONFIDENCE,
      observedAt,
      evidence,
    });
  }

  const { written } = await writeClaims(client, inputs);

  // Reproject prose + embedding from the fuller claim set. If nothing was written
  // (Exa returned an empty object) there is nothing new to summarise, so skip it.
  if (written.length > 0) await summarizeEntity(client, opts.entityId);

  return {
    enriched: true,
    claimsWritten: written.length,
    costDollars: data.costDollars?.total ?? null,
  };
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
