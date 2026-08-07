import { describe, expect, it } from "vitest";
import { bucketPeopleByDomain, nameFromDomain, COMPANY_MIN_PEOPLE } from "./reconcile-companies";

// Locks the threshold + bucketing logic that decides which domains become company
// entities, without a Supabase client. The DB-touching parts of reconcileCompanies
// (org create, edge upsert, Exa enrichment) are covered by the end-to-end run in the
// plan; these are the rules that must never quietly drift.

const rows = (...pairs: [string, string][]) =>
  pairs.map(([subject_id, value]) => ({ subject_id, value }));

describe("bucketPeopleByDomain", () => {
  it("groups distinct people by their email domain", () => {
    const buckets = bucketPeopleByDomain(
      rows(["p1", "a@stripe.com"], ["p2", "b@stripe.com"], ["p3", "c@ramp.com"]),
    );
    expect(buckets.get("stripe.com")).toEqual(new Set(["p1", "p2"]));
    expect(buckets.get("ramp.com")).toEqual(new Set(["p3"]));
  });

  it("excludes free-mail / generic domains", () => {
    const buckets = bucketPeopleByDomain(
      rows(["p1", "a@gmail.com"], ["p2", "b@outlook.com"], ["p3", "c@icloud.com"]),
    );
    expect(buckets.size).toBe(0);
  });

  it("counts each entity once even if the same subject appears twice", () => {
    const buckets = bucketPeopleByDomain(rows(["p1", "a@stripe.com"], ["p1", "a@stripe.com"]));
    expect(buckets.get("stripe.com")).toEqual(new Set(["p1"]));
  });

  it("drops malformed addresses and non-string values instead of throwing", () => {
    const buckets = bucketPeopleByDomain([
      { subject_id: "p1", value: "not-an-email" },
      { subject_id: "p2", value: 42 },
      { subject_id: "p3", value: null },
      { subject_id: "p4", value: "ok@stripe.com" },
    ]);
    expect([...buckets.keys()]).toEqual(["stripe.com"]);
    expect(buckets.get("stripe.com")).toEqual(new Set(["p4"]));
  });
});

describe("the > 5 boundary", () => {
  const domainWith = (n: number) =>
    bucketPeopleByDomain(
      Array.from({ length: n }, (_, i) => ({ subject_id: `p${i}`, value: `p${i}@stripe.com` })),
    ).get("stripe.com")!;

  it("does NOT qualify a domain with exactly 5 people", () => {
    expect(domainWith(5).size < COMPANY_MIN_PEOPLE).toBe(true);
  });

  it("qualifies a domain with 6 people (strictly more than 5)", () => {
    expect(domainWith(6).size >= COMPANY_MIN_PEOPLE).toBe(true);
  });
});

describe("nameFromDomain", () => {
  it("capitalises the second-level label", () => {
    expect(nameFromDomain("stripe.com")).toBe("Stripe");
  });

  it("uses the second-level label for multi-part domains", () => {
    expect(nameFromDomain("mail.ramp.com")).toBe("Ramp");
  });
});
