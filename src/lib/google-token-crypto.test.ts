import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken } from "./google-token-crypto";

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.GOOGLE_TOKEN_ENC_KEY;
  process.env.GOOGLE_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_TOKEN_ENC_KEY;
  else process.env.GOOGLE_TOKEN_ENC_KEY = savedKey;
});

describe("google token crypto", () => {
  it("round-trips a refresh token", () => {
    const token = "1//refresh-token-value-" + randomBytes(16).toString("hex");
    const encoded = encryptToken(token);
    expect(encoded.startsWith("v1:")).toBe(true);
    expect(encoded).not.toContain(token);
    expect(decryptToken(encoded)).toBe(token);
  });

  it("produces a different ciphertext each call (fresh IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("throws on tampered ciphertext rather than returning garbage", () => {
    const encoded = encryptToken("secret");
    const raw = Buffer.from(encoded.slice(3), "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext bit
    const tampered = "v1:" + raw.toString("base64");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws under the wrong key", () => {
    const encoded = encryptToken("secret");
    process.env.GOOGLE_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
    expect(() => decryptToken(encoded)).toThrow();
  });

  it("rejects unknown formats and truncated payloads", () => {
    expect(() => decryptToken("v2:abcdef")).toThrow(/format/);
    expect(() => decryptToken("v1:AAAA")).toThrow(/short/);
  });

  it("refuses a key that is not 32 bytes", () => {
    process.env.GOOGLE_TOKEN_ENC_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });
});
