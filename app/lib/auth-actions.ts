"use server";

import { signIn } from "@/src/auth";

/**
 * Starts Google sign-in the only way that works here.
 *
 * A plain link to /api/auth/signin does NOT work: pages.signIn is "/" (see
 * src/auth.ts), so that endpoint redirects straight back to the landing page in
 * a loop. Sign-in needs a POST carrying the CSRF token, which is exactly what
 * `signIn` issues. Used by every server-rendered "Continue with Gmail" CTA; the
 * client-rendered ones (the rail) call next-auth/react's signIn instead.
 */
export async function startGoogleSignIn() {
  await signIn("google", { redirectTo: "/onboarding" });
}
