import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { GOOGLE_SCOPES } from "./lib/google-scopes";

/**
 * Gmail-ingest auth (Nexus v0.2 build step 2, SPEC.md §3.3). Ported from
 * nexus's src/auth.ts. This is a SECOND, deliberately separate auth system
 * from the member-facing Supabase Auth (app/lib/supabase-browser.ts) and the
 * admin allowlist (app/lib/admin-auth.ts) — it exists only to get a Google
 * access token for whichever mailbox(es) are the ingest source, not as a
 * general sign-in mechanism.
 *
 * SPEC §3.3: ship internal-only to Interplay's Workspace — the only shape
 * that keeps CASA (third-party security assessment) off the critical path.
 * Enforced below via the `hd` (hosted domain) claim Google puts on the ID
 * token for Workspace accounts: a personal @gmail.com account has no `hd`
 * claim at all and is rejected, not merely unprivileged.
 */
function allowedDomains(): string[] {
  return (process.env.ADMIN_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

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
          // access_type=offline gets a refresh token back. Deliberately no
          // `prompt: "consent"` — Google already re-shows consent on its own
          // when a sign-in requests scopes beyond what was previously granted.
          access_type: "offline",
          scope: GOOGLE_SCOPES.join(" "),
        },
      },
    }),
  ],
  secret: process.env.AUTH_SECRET,
  callbacks: {
    async signIn({ profile }) {
      const domains = allowedDomains();
      if (!domains.length) return false; // deny by default — same posture as admin-auth.ts
      const hd = (profile as { hd?: string } | undefined)?.hd?.toLowerCase();
      return !!hd && domains.includes(hd);
    },
    async jwt({ token, account }) {
      if (account) {
        if (account.providerAccountId) token.sub = account.providerAccountId;
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
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
});
