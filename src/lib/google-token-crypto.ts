// AES-256-GCM for Google refresh tokens at rest (google_accounts.refresh_token_enc).
//
// App-layer rather than pgsodium: pgsodium is deprecated on Supabase, all DB
// access here is PostgREST (no direct pg connection for transparent decryption
// to ride), and keeping GOOGLE_TOKEN_ENC_KEY out of the database means a leaked
// dump or a leaked service-role key alone yields ciphertext. Decryption happens
// only in the Node runtime that already holds GOOGLE_CLIENT_SECRET.
//
// Key: GOOGLE_TOKEN_ENC_KEY, 32 bytes base64 (`openssl rand -base64 32`).
// Format: "v1:" + base64(iv(12) | authTag(16) | ciphertext) — versioned so a
// future key rotation can distinguish old rows.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.GOOGLE_TOKEN_ENC_KEY;
  if (!raw) throw new Error("GOOGLE_TOKEN_ENC_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("GOOGLE_TOKEN_ENC_KEY must be 32 bytes of base64 (openssl rand -base64 32)");
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

/** Throws on tamper, truncation, or the wrong key — never returns garbage. */
export function decryptToken(encoded: string): string {
  const [version, payload] = encoded.split(":", 2);
  if (version !== VERSION || !payload) {
    throw new Error(`Unrecognized token ciphertext format (${version ?? "empty"})`);
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error("Token ciphertext too short");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
