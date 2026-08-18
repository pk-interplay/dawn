import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { GOOGLE_SCOPES } from "./lib/google-scopes";
import { supabase } from "./lib/supabase";
import { findOrCreateEntity } from "./lib/claims";
import { isAllowedSignIn } from "./lib/allowlist";
import {
  refreshGoogleAccessToken,
  upsertGoogleAccount,
} from "./lib/google-account";

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
 * ## Invite-only, at the door
 *
 * The `signIn` callback gates every sign-in on the allowlist in
 * src/lib/allowlist.ts (ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS, deny-by-default;
 * domains admit only via Google's Workspace-asserted `hd` claim). This replaced a
 * period where any Google account on earth could sign in and ingest its mailbox
 * into the shared workspace — an internal pilot has no business accepting
 * strangers, and SPEC §3.3's compliance argument (internal-use apps are exempt
 * from Google verification and CASA) only holds while membership is controlled.
 *
 * The per-surface gates are unchanged and still matter:
 *   - `requireAdmin` (app/lib/admin-auth.ts) allowlists the operator surfaces on
 *     ADMIN_EMAILS / ADMIN_EMAIL_DOMAINS — admins are a subset of members.
 *   - A denied sign-in redirects to `/?error=AccessDenied`, which the landing page
 *     renders as an invite-only notice.
 *
 * **Before this app is offered to anyone outside Interplay's Workspace, re-read
 * SPEC §3.3.** Adding a personal-gmail member via ALLOWED_EMAILS forces the OAuth
 * client to "External", which puts restricted-scope verification back in view.
 */

// Token refresh lives in src/lib/google-account.ts now — ONE implementation for
// the cookie path (here) and the server-side store (crons, onboarding routes),
// with invalid_grant distinguished from transient token-endpoint failures.

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
    async signIn({ profile }) {
      // Invite-only. Returning false sends the visitor to `/?error=AccessDenied`
      // (pages.signIn is "/"), which the landing page renders as a quiet notice.
      return isAllowedSignIn({
        email: profile?.email,
        emailVerified: profile?.email_verified as boolean | undefined,
        hd: (profile as { hd?: string } | null)?.hd,
      });
    },
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

        // Persist the credentials server-side (google_accounts) so background
        // work — the Gmail sync cron, the onboarding routes — can act for this
        // user without the browser cookie. prompt=consent above means every
        // sign-in carries a fresh refresh token, so this also heals a revoked
        // row. Best-effort: sign-in must never block on Supabase.
        if (token.sub && profile?.email) {
          try {
            await upsertGoogleAccount(supabase, {
              googleSub: token.sub,
              email: profile.email,
              refreshToken: account.refresh_token ?? null,
              accessToken: account.access_token ?? null,
              expiresAt: account.expires_at ?? null,
              scopes: (account.scope as string | undefined) ?? GOOGLE_SCOPES.join(" "),
            });
          } catch (err) {
            console.error("[auth] Failed to persist Google credentials:", err);
          }
        }

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
          // Best-effort: keep the server-side store current too, so the cookie
          // path and the cron path never diverge on which token is live.
          if (token.sub && token.email) {
            void upsertGoogleAccount(supabase, {
              googleSub: token.sub,
              email: token.email,
              refreshToken: refreshed.refreshToken,
              accessToken: refreshed.accessToken,
              expiresAt: refreshed.expiresAt,
            }).catch((err) => console.error("[auth] Failed to persist rotated token:", err));
          }
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
