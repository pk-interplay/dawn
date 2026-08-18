// The single server-side authority for Google credentials (google_accounts).
//
// Written from the NextAuth jwt callback at sign-in (upsertGoogleAccount) and
// read by everything that needs to act on a mailbox — the onboarding routes and
// the background sync. Before this table, the refresh token lived only in the
// browser cookie: rotation was never persisted (the token endpoint got hit again
// on nearly every request), no cron could ever re-read a mailbox, and a 30-day
// idle session silently destroyed the only copy of the credential.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "./google-token-crypto";
import { withRetry } from "./retry";

export type TokenResult =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      /** missing = no row / no refresh token; revoked = invalid_grant (user must
       *  sign in again); transient = Google's token endpoint hiccuped, retry later. */
      reason: "missing" | "revoked" | "transient";
      detail?: string;
    };

/** How close to expiry a cached access token is still handed out. Mirrors the
 *  jwt callback's own 60s margin. */
const EXPIRY_MARGIN_S = 60;

class InvalidGrantError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidGrantError";
  }
}

/**
 * One refresh implementation for the whole app (the jwt callback delegates here
 * too). Distinguishes the two failures the old code conflated: `invalid_grant`
 * (the grant is dead — revoked or expired past repair; re-auth is the only fix)
 * versus a transient 5xx/network failure (retry; the grant is fine).
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number; // epoch seconds
  refreshToken: string;
}> {
  return withRetry(
    async () => {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (/invalid_grant/i.test(body)) {
          throw new InvalidGrantError(`Google refused the refresh token: ${body.slice(0, 200)}`);
        }
        throw new Error(`Google token endpoint returned ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return {
        accessToken: data.access_token as string,
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
        // Google only returns a new refresh_token occasionally; keep the old one otherwise.
        refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
      };
    },
    {
      label: "[google-token]",
      attempts: 3,
      // invalid_grant and other 4xx are terminal; 5xx/network retry briefly. A
      // single blip on Google's token endpoint must not read as a revoked grant.
      classify: (err) => {
        if (err instanceof InvalidGrantError) return { kind: "invalid_grant", retryable: false };
        if (err instanceof Error && /returned 4\d\d/.test(err.message)) {
          return { kind: "terminal", retryable: false };
        }
        return { kind: "transient", retryable: true, baseMs: 500 };
      },
    },
  );
}

/**
 * Upsert from the NextAuth jwt callback at sign-in (and on cookie-path
 * rotation). prompt=consent means every sign-in carries a fresh refresh token,
 * so this also HEALS a previously revoked row: revoked_at clears, counters reset.
 * Best-effort at the caller — sign-in must never block on this write.
 */
export async function upsertGoogleAccount(
  client: SupabaseClient,
  row: {
    googleSub: string;
    email: string;
    refreshToken?: string | null;
    accessToken?: string | null;
    /** epoch seconds */
    expiresAt?: number | null;
    scopes?: string | null;
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    google_sub: row.googleSub,
    email: row.email,
    updated_at: new Date().toISOString(),
  };
  if (row.refreshToken) {
    update.refresh_token_enc = encryptToken(row.refreshToken);
    update.revoked_at = null;
    update.refresh_failure_count = 0;
  }
  if (row.accessToken) {
    update.access_token = row.accessToken;
    update.access_token_expires_at = row.expiresAt
      ? new Date(row.expiresAt * 1000).toISOString()
      : null;
  }
  if (row.scopes) update.scopes = row.scopes;

  const { error } = await client.from("google_accounts").upsert(update, { onConflict: "google_sub" });
  if (error) throw new Error(`google_accounts upsert failed: ${error.message}`);
}

export async function markGoogleAccountRevoked(
  client: SupabaseClient,
  googleSub: string,
  detail: string,
): Promise<void> {
  const { error } = await client
    .from("google_accounts")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("google_sub", googleSub);
  if (error) console.error(`[google-account] could not mark ${googleSub} revoked: ${error.message}`);
  console.warn(`[google-account] grant revoked for ${googleSub}: ${detail}`);
}

/**
 * A fresh access token for one Google account, from the server-side store.
 *
 * Fast path: the cached access token when it has >60s to live — which is also
 * what lets a cron pass and an interactive route in the same hour share one
 * token and therefore one QuotaWindow entry. Otherwise refresh, persist the
 * rotation, and on invalid_grant mark the account revoked (surfaced to the user
 * as "reconnect Google"; healed by their next sign-in).
 */
export async function getGoogleAccessToken(
  client: SupabaseClient,
  googleSub: string,
): Promise<TokenResult> {
  const { data: row, error } = await client
    .from("google_accounts")
    .select("refresh_token_enc, access_token, access_token_expires_at, revoked_at, refresh_failure_count")
    .eq("google_sub", googleSub)
    .maybeSingle();
  if (error) return { ok: false, reason: "transient", detail: error.message };
  if (!row || !row.refresh_token_enc) return { ok: false, reason: "missing" };
  if (row.revoked_at) return { ok: false, reason: "revoked", detail: `revoked at ${row.revoked_at}` };

  if (
    row.access_token &&
    row.access_token_expires_at &&
    Date.parse(row.access_token_expires_at) > Date.now() + EXPIRY_MARGIN_S * 1000
  ) {
    return { ok: true, accessToken: row.access_token as string };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refresh_token_enc as string);
  } catch (err) {
    // Wrong key or corrupted row — unrecoverable without a re-auth, same
    // user-facing posture as a revoked grant.
    const detail = err instanceof Error ? err.message : String(err);
    await markGoogleAccountRevoked(client, googleSub, `ciphertext unreadable: ${detail}`);
    return { ok: false, reason: "revoked", detail };
  }

  try {
    const refreshed = await refreshGoogleAccessToken(refreshToken);
    // Plain update, not upsert — the row exists (we just read it), and an upsert
    // would require re-supplying columns like email that must not be clobbered.
    // Persisting the rotation is the point: the old cookie-only flow re-refreshed
    // on every request because the rotated token was thrown away.
    const { error: persistErr } = await client
      .from("google_accounts")
      .update({
        refresh_token_enc: encryptToken(refreshed.refreshToken),
        access_token: refreshed.accessToken,
        access_token_expires_at: new Date(refreshed.expiresAt * 1000).toISOString(),
        refresh_failure_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("google_sub", googleSub);
    if (persistErr) {
      console.error(`[google-account] refreshed but could not persist rotation: ${persistErr.message}`);
    }
    return { ok: true, accessToken: refreshed.accessToken };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "InvalidGrantError") {
      await markGoogleAccountRevoked(client, googleSub, detail);
      return { ok: false, reason: "revoked", detail };
    }
    await client
      .from("google_accounts")
      .update({
        refresh_failure_count: ((row.refresh_failure_count as number) ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("google_sub", googleSub);
    return { ok: false, reason: "transient", detail };
  }
}
