import { describe, expect, it } from "vitest";
import { parseAddress, recencyWeight, splitAddresses } from "./network-ingest";

// Behaviour lock for the pure address/decay helpers ported from nexus's
// relationships.ts, ahead of build step 2's Gmail ingest depending on them.

describe("parseAddress", () => {
  it("parses a display-name + angle-bracket address", () => {
    expect(parseAddress("Ava Chen <ava@example.com>")).toEqual({ email: "ava@example.com", name: "Ava Chen" });
  });

  it("parses a bare address with no display name, using the email as the name", () => {
    expect(parseAddress("ava@example.com")).toEqual({ email: "ava@example.com", name: "ava@example.com" });
  });

  it("lowercases the email but preserves display-name casing", () => {
    expect(parseAddress("Ava Chen <AVA@Example.COM>")).toEqual({ email: "ava@example.com", name: "Ava Chen" });
  });

  it("returns null for garbage input", () => {
    expect(parseAddress("not an address")).toBeNull();
  });
});

describe("splitAddresses", () => {
  it("splits a comma-separated header into multiple addresses", () => {
    expect(splitAddresses("Ava <ava@example.com>, Ben <ben@example.com>")).toEqual([
      { email: "ava@example.com", name: "Ava" },
      { email: "ben@example.com", name: "Ben" },
    ]);
  });

  it("returns an empty array for an absent header rather than throwing", () => {
    expect(splitAddresses(undefined)).toEqual([]);
  });

  it("drops unparseable entries instead of failing the whole header", () => {
    expect(splitAddresses("Ava <ava@example.com>, garbage")).toEqual([{ email: "ava@example.com", name: "Ava" }]);
  });
});

describe("recencyWeight", () => {
  it("weights a just-now interaction at ~1", () => {
    expect(recencyWeight(Date.now())).toBeCloseTo(1, 2);
  });

  it("weights an interaction exactly one half-life ago at ~0.5", () => {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    expect(recencyWeight(ninetyDaysAgo)).toBeCloseTo(0.5, 2);
  });

  it("never returns a weight above 1 for a future timestamp", () => {
    expect(recencyWeight(Date.now() + 1000 * 60 * 60 * 24)).toBeLessThanOrEqual(1);
  });
});
