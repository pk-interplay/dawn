import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedSignIn } from "./allowlist";

let savedEmails: string | undefined;
let savedDomains: string | undefined;

beforeEach(() => {
  savedEmails = process.env.ALLOWED_EMAILS;
  savedDomains = process.env.ALLOWED_EMAIL_DOMAINS;
  delete process.env.ALLOWED_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
});

afterEach(() => {
  if (savedEmails === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = savedEmails;
  if (savedDomains === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
  else process.env.ALLOWED_EMAIL_DOMAINS = savedDomains;
});

describe("isAllowedSignIn", () => {
  it("fails closed: both vars unset denies everyone", () => {
    expect(isAllowedSignIn({ email: "pk@interplay.vc", hd: "interplay.vc" })).toBe(false);
  });

  it("admits an exact ALLOWED_EMAILS entry, case-insensitively", () => {
    process.env.ALLOWED_EMAILS = "Guest@Gmail.com, other@example.com";
    expect(isAllowedSignIn({ email: "guest@gmail.com" })).toBe(true);
    expect(isAllowedSignIn({ email: "GUEST@GMAIL.COM" })).toBe(true);
    expect(isAllowedSignIn({ email: "stranger@gmail.com" })).toBe(false);
  });

  it("admits a domain ONLY via the hd claim — the spoof case is denied", () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "interplay.vc";
    // The load-bearing case: an email that LOOKS right but carries no Workspace
    // hd claim (a consumer account with a lookalike address, or a forged email
    // claim) must not get in. Google asserts hd only for real Workspace accounts.
    expect(isAllowedSignIn({ email: "pk@interplay.vc" })).toBe(false);
    expect(isAllowedSignIn({ email: "pk@interplay.vc", hd: null })).toBe(false);
    expect(isAllowedSignIn({ email: "pk@interplay.vc", hd: "interplay.vc" })).toBe(true);
    expect(isAllowedSignIn({ email: "pk@evil.com", hd: "evil.com" })).toBe(false);
  });

  it("tolerates an @-prefixed domain in the env var", () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "@interplay.vc";
    expect(isAllowedSignIn({ email: "pk@interplay.vc", hd: "interplay.vc" })).toBe(true);
  });

  it("denies an explicitly unverified email even when listed", () => {
    process.env.ALLOWED_EMAILS = "guest@gmail.com";
    expect(isAllowedSignIn({ email: "guest@gmail.com", emailVerified: false })).toBe(false);
    // Only an explicit false denies; an absent claim does not.
    expect(isAllowedSignIn({ email: "guest@gmail.com", emailVerified: null })).toBe(true);
  });

  it("denies a missing email outright", () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "interplay.vc";
    expect(isAllowedSignIn({ email: null, hd: "interplay.vc" })).toBe(false);
  });
});
