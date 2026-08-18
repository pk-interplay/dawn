import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthorized, isInboundAuthorized } from "./authz";

// The two bearer gates read process.env at call time, so each test sets exactly
// the world it means to test and restores it after.

const CRON = "cron-secret-value-0123456789";
const INBOUND = "inbound-secret-value-9876543210";

function req(header?: string): Request {
  return new Request("http://localhost/api/test", {
    headers: header === undefined ? {} : { authorization: header },
  });
}

let savedCron: string | undefined;
let savedInbound: string | undefined;

beforeEach(() => {
  savedCron = process.env.CRON_SECRET;
  savedInbound = process.env.INBOUND_WEBHOOK_SECRET;
  process.env.CRON_SECRET = CRON;
  process.env.INBOUND_WEBHOOK_SECRET = INBOUND;
});

afterEach(() => {
  if (savedCron === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedCron;
  if (savedInbound === undefined) delete process.env.INBOUND_WEBHOOK_SECRET;
  else process.env.INBOUND_WEBHOOK_SECRET = savedInbound;
});

describe("isAuthorized (CRON_SECRET)", () => {
  it("denies when the secret is unset — the surface is closed, not open", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorized(req(`Bearer ${CRON}`))).toBe(false);
  });

  it("denies a missing or malformed header", () => {
    expect(isAuthorized(req())).toBe(false);
    expect(isAuthorized(req(CRON))).toBe(false); // no "Bearer " prefix
    expect(isAuthorized(req(`Basic ${CRON}`))).toBe(false);
  });

  it("denies wrong, truncated, and padded bearers", () => {
    expect(isAuthorized(req("Bearer nope"))).toBe(false);
    expect(isAuthorized(req(`Bearer ${CRON.slice(0, -1)}`))).toBe(false);
    expect(isAuthorized(req(`Bearer ${CRON}x`))).toBe(false);
  });

  it("allows the exact bearer", () => {
    expect(isAuthorized(req(`Bearer ${CRON}`))).toBe(true);
  });
});

describe("isInboundAuthorized (INBOUND_WEBHOOK_SECRET)", () => {
  it("denies when the secret is unset", () => {
    delete process.env.INBOUND_WEBHOOK_SECRET;
    expect(isInboundAuthorized(req(`Bearer ${INBOUND}`))).toBe(false);
  });

  it("allows the exact bearer", () => {
    expect(isInboundAuthorized(req(`Bearer ${INBOUND}`))).toBe(true);
  });
});

describe("the two secrets do not satisfy each other's gate", () => {
  // The whole reason there are two: a leaked cron secret must not forge inbound
  // mail, and vice versa.
  it("cron secret is refused at the inbound gate", () => {
    expect(isInboundAuthorized(req(`Bearer ${CRON}`))).toBe(false);
  });
  it("inbound secret is refused at the cron gate", () => {
    expect(isAuthorized(req(`Bearer ${INBOUND}`))).toBe(false);
  });
});
