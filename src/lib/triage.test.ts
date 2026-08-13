import { describe, expect, it } from "vitest";
import { baseAddress, extractEmail, extractName } from "./triage";

// Behaviour lock for the three pure address helpers, written BEFORE the port to
// the Nexus schema (build plan §4 Phase 2).
//
// These are not incidental string utilities. `baseAddress` is what makes the
// thread-alias path work: Nexus writes to `pk+ava@interplay.vc`, the human
// replies from `pk@interplay.vc`, and `resolveSender` only accepts that reply as
// Ava because both addresses reduce to the same base. Change the reduction and
// either every persona reply becomes a non-member, or — worse — unrelated
// senders start resolving to each other.

describe("extractEmail", () => {
  it("returns null for absent input rather than throwing", () => {
    // The route builds fromRaw with firstDefined(), which can legitimately be
    // null. Triage runs before the audit row is written, so a throw here would
    // 500 the request, skip the replay guard, and let AgentMail retry forever.
    expect(extractEmail(null)).toBeNull();
    expect(extractEmail(undefined)).toBeNull();
    expect(extractEmail("")).toBeNull();
  });

  it("pulls the address out of an angle-bracket display form", () => {
    expect(extractEmail("Ava Chen <ava@example.com>")).toBe("ava@example.com");
    expect(extractEmail('"Chen, Ava" <ava@example.com>')).toBe("ava@example.com");
  });

  it("accepts a bare address", () => {
    expect(extractEmail("ava@example.com")).toBe("ava@example.com");
  });

  it("normalises case and surrounding whitespace", () => {
    // Downstream lookups compare with ilike and with ===, so the casing has to
    // be settled here rather than at each call site.
    expect(extractEmail("  AVA@Example.COM  ")).toBe("ava@example.com");
    expect(extractEmail("Ava <  AVA@Example.COM  >")).toBe("ava@example.com");
  });

  it("rejects anything without a dotted domain", () => {
    // The regex requires .+@.+\..+ — a bare hostname is not a deliverable
    // address, and treating it as one would create member rows that can never
    // receive mail.
    expect(extractEmail("ava@localhost")).toBeNull();
    expect(extractEmail("not-an-address")).toBeNull();
    expect(extractEmail("@example.com")).toBeNull();
  });
});

describe("baseAddress", () => {
  it("strips a plus tag from the local part", () => {
    expect(baseAddress("pk+ava@interplay.vc")).toBe("pk@interplay.vc");
  });

  it("leaves an untagged address alone", () => {
    expect(baseAddress("pk@interplay.vc")).toBe("pk@interplay.vc");
  });

  it("strips from the first plus onward", () => {
    expect(baseAddress("pk+ava+chen@interplay.vc")).toBe("pk@interplay.vc");
  });

  it("ignores a plus in the domain", () => {
    // The local part is everything before the LAST @, and the plus search runs
    // only inside it — so a domain containing a plus is not truncated.
    expect(baseAddress("pk@ex+ample.com")).toBe("pk@ex+ample.com");
  });

  it("splits on the last @, not the first", () => {
    // Quoted local parts can legally contain @. Splitting on the first one
    // would move part of the local into the domain.
    expect(baseAddress('"weird@local"+tag@example.com')).toBe('"weird@local"@example.com');
  });

  it("returns input unchanged when there is no @", () => {
    expect(baseAddress("nonsense")).toBe("nonsense");
  });

  it("reduces a leading-plus address to a bare domain — known sharp edge", () => {
    // Documented, not endorsed. An empty local part means `+a@x.com` and
    // `+b@x.com` both reduce to `@x.com`, so resolveSender's base-match would
    // treat them as the same mailbox. Unreachable today (demo-personas.ts always
    // builds `<local>+<tag>@<domain>` from DEMO_PERSONA_INBOX, so the local part
    // is never empty), but the port should reject an empty local part outright
    // rather than rely on that.
    expect(baseAddress("+ava@interplay.vc")).toBe("@interplay.vc");
  });
});

describe("extractName", () => {
  it("returns null for absent input", () => {
    expect(extractName(null)).toBeNull();
    expect(extractName(undefined)).toBeNull();
  });

  it("reads an unquoted display name", () => {
    expect(extractName("Ava Chen <ava@example.com>")).toBe("Ava Chen");
  });

  it("reads a quoted display name without the quotes", () => {
    expect(extractName('"Ava Chen" <ava@example.com>')).toBe("Ava Chen");
  });

  it("returns null for a bare address with no display part", () => {
    expect(extractName("ava@example.com")).toBeNull();
  });

  it("refuses a display name that is itself an address", () => {
    // Some clients set the display name to the address. Storing that as
    // `leads.name` would produce "ava@example.com" as a person's name.
    expect(extractName("ava@example.com <ava@example.com>")).toBeNull();
  });
});
