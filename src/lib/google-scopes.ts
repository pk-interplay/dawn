/**
 * Scopes requested at sign-in (src/auth.ts). Ported from nexus's
 * google-scopes.ts, trimmed for Nexus v0.2 build step 2 (SPEC.md §3.3, §7):
 * ingest is metadata-only for now, so `gmail.compose`/`gmail.send` are dropped
 * — requesting scopes a step doesn't use yet fails the "least privilege for an
 * internal Workspace app" posture cleanly, and CASA/verification only
 * triggers on *storing or transmitting* restricted-scope content, which an
 * unused scope grant doesn't change anyway. Re-add compose/send when step 5's
 * send gateway needs them.
 *
 * Sign-in DOES force `prompt: "consent"` (src/auth.ts, since 2c38160), so every
 * authorization re-shows the consent screen and reissues a refresh token —
 * adding a scope here re-prompts existing users on their next sign-in.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;
