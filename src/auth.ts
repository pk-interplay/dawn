import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { GOOGLE_SCOPES } from "./lib/google-scopes";
import { supabase } from "./lib/supabase";
import { findOrCreateEntity } from "./lib/claims";

/**
 * THE auth system. Google only.
 *
 * This used to be one of two: a Supabase email+password system served members
 * (/login, /join, /me, password reset) while this file existed solely to get a
 * Google access token for Gmail ingest. That split meant two notions of "who am
 * I" — a Supabase user id and a Google `sub` — with no link between them, so the
 * ingested graph belonged to an identity the app's own session could not name.
 * Supabase Auth is gone; a Google account is now the only way in, and the Google
 * `sub` is the single identity everything keys on.
 *
 * ## Any Gmail account, deliberately
 *
 * There used to be a `signIn` callback here rejecting any account whose ID token
 * carried no `hd` (Workspace hosted-domain) claim — which is every personal
 * @gmail.com account. It cited SPEC §3.3: internal-use apps are exempt from
 * Google verification and CASA, and CASA triggers on storing restricted-scope
 * data, which Gmail ingest does.
 *
 * That reasoning still holds and the constraint has NOT gone away — it has moved.
 * Access is now gated per surface rather than at the door:
 *
 *   - `requireAdmin` (app/lib/admin-auth.ts) still allowlists on ADMIN_EMAILS /
 *     ADMIN_EMAIL_DOMAINS, deny-by-default, so the operator surfaces are unchanged.
 *   - Anyone signing in gets an entity in the single Interplay workspace and can
 *     ingest their own mailbox and query the graph.
 *
 * **Before this app is offered to anyone outside Interplay's Workspace, re-read
 * SPEC §3.3.** Restricted-scope data leaving an internal-use app is what puts a
 * third-party security assessment on the critical path, and that is a launch
 * dependency, not a compliance footnote. Nothing in the code will stop you.
 */

/** Refreshes an expired Google access token using the stored refresh token. */
async function refreshGoogleAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh Google access token: ${res.status}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token as string,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
    // Google only returns a new refresh_token occasionally; keep the old one otherwise.
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
  };
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          // access_type=offline gets a refresh token back, but only on the FIRST
          // authorization for a given user — after that Google returns an access
          // token alone unless consent is re-requested explicitly.
          //
          // This file used to omit `prompt: "consent"`, reasoning that Google
          // re-shows consent by itself when a sign-in asks for scopes beyond what
          // was already granted. True, and beside the point: the case that breaks
          // is re-auth with *unchanged* scopes — a second device, a cleared cookie
          // jar, a fresh session. There Google returns no refresh token, the jwt
          // callback below has none to store, and an hour later the access token
          // expires with nothing to renew it from. The user is told to sign in
          // again, does, and lands in exactly the same state: a loop only a manual
          // revoke in Google account settings escapes, which no user will find.
          //
          // prompt=consent makes Google reissue a refresh token on every
          // authorization. The cost is a consent screen at each sign-in rather than
          // just the first — the right trade for an app whose whole function is
          // offline access to the mailbox.
          prompt: "consent",
          access_type: "offline",
          scope: GOOGLE_SCOPES.join(" "),
        },
      },
    }),
  ],
  secret: process.env.AUTH_SECRET,
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        // Auth.js deliberately assigns `user.id` a random UUID on every sign-in
        // when there is no database adapter (see @auth/core's getUserAndAccount:
        // "the user's id is intentionally not set based on the profile id").
        // Without pinning it, every login gets a fresh unrelated id and all
        // previously-ingested data becomes invisible. account.providerAccountId
        // is the stable Google account id (profile.sub) — pin to that.
        if (account.providerAccountId) token.sub = account.providerAccountId;
        token.accessToken = account.access_token;
        // Never overwrite a good refresh token with undefined. prompt=consent above
        // means Google should always send one, but a provider that declines to (or a
        // future change to those params) would otherwise silently erase the only
        // credential that can renew access — and the erasure is unrecoverable from
        // the user's side. Keep whatever we already had.
        token.refreshToken = account.refresh_token ?? token.refreshToken;
        token.expiresAt = account.expires_at;

        // Claim the caller's entity and stamp it with this Google id, so
        // "which entity is the signed-in user" is answerable from the session
        // alone rather than re-derived from an email claim on every request.
        //
        // findOrCreateEntity resolves by the live `email` claim, so a user who
        // already appears in the graph as somebody else's contact is ADOPTED
        // rather than duplicated — which is the whole point of doing it here
        // instead of at first ingest.
        //
        // Best-effort: never block sign-in on it. If Supabase is down the user
        // still gets a session, and the onboarding route resolves the entity
        // again on its own.
        if (token.sub && profile?.email) {
          try {
            const entityId = await findOrCreateEntity(supabase, {
              kind: "person",
              matchHint: { email: profile.email },
            });
            const { error } = await supabase
              .from("entities")
              .update({ auth_user_id: token.sub })
              .eq("id", entityId)
              .is("auth_user_id", null); // never steal an entity already claimed
            if (error) throw new Error(error.message);
          } catch (err) {
            console.error("[auth] Failed to link entity to Google account:", err);
          }
        }
        return token;
      }
      if (token.expiresAt && Date.now() / 1000 > (token.expiresAt as number) - 60) {
        if (!token.refreshToken) {
          console.error("[auth] No refresh token available; forcing re-sign-in.");
          token.accessToken = undefined;
          return token;
        }
        try {
          const refreshed = await refreshGoogleAccessToken(token.refreshToken as string);
          token.accessToken = refreshed.accessToken;
          token.expiresAt = refreshed.expiresAt;
          token.refreshToken = refreshed.refreshToken;
        } catch (err) {
          console.error("[auth] Failed to refresh Google access token:", err);
          token.accessToken = undefined; // Force re-auth on next Google API call.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.accessToken = token.accessToken as string | undefined;
      return session;
    },
  },
  pages: {
    // The landing page IS the sign-in page (one pill, "Continue with Gmail"), so
    // an unauthenticated redirect should land there rather than on Auth.js's
    // built-in provider-picker — there is only one provider to pick.
    signIn: "/",
  },
});
