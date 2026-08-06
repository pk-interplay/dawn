import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      /** Google account id (from token.sub). */
      id: string;
    } & DefaultSession["user"];
    /** Live Google access token for the signed-in user, refreshed as needed in src/auth.ts. */
    accessToken?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  }
}
