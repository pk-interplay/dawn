import { auth } from "../../src/auth";

// Allowlist gate for the admin routes (/api/admin/*).
//
// The email comes from the NextAuth session — i.e. from Google's verified `email`
// claim — rather than from a Supabase token in an `Authorization` header, which is
// what this read before Google became the only way in. The allowlist logic itself
// is unchanged, and remains the ONLY thing separating an operator from an ordinary
// member now that the door is open to any Google account (see src/auth.ts):
//
//   ADMIN_EMAIL_DOMAINS — whole domains, e.g. "interplay.vc" (the common case:
//                         anyone on the team gets in without a per-person edit)
//   ADMIN_EMAILS        — individual addresses, for guests outside those domains
//
// If BOTH are unset the routes are closed — deny by default, same posture as
// isAuthorized() in ./authz.ts.
function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function adminEmails(): string[] {
  return splitList(process.env.ADMIN_EMAILS);
}

function adminDomains(): string[] {
  // Tolerate "@interplay.vc" as well as "interplay.vc".
  return splitList(process.env.ADMIN_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
}

/**
 * The domain of an address, taken after the LAST `@`.
 *
 * Deliberately not `email.endsWith(domain)`: that would admit
 * `mallory@evil-interplay.vc`, and a first-`@` split can be fooled by a quoted
 * local part like `"a@interplay.vc"@evil.com`. Matching is exact equality against
 * this value, so subdomains do not inherit access either.
 */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

export type AdminCheck = { ok: true; email: string } | { ok: false; status: number; error: string };

// `req` is unused — the session comes from the request cookie via auth(). Kept in
// the signature so every /api/admin/* route did not have to change in the same
// commit as the auth swap.
export async function requireAdmin(_req?: Request): Promise<AdminCheck> {
  const allowedEmails = adminEmails();
  const allowedDomains = adminDomains();
  if (!allowedEmails.length && !allowedDomains.length) {
    return {
      ok: false,
      status: 503,
      error: "Set ADMIN_EMAIL_DOMAINS or ADMIN_EMAILS to open the admin surfaces",
    };
  }

  const session = await auth();
  if (!session?.user?.email) {
    return { ok: false, status: 401, error: "Not signed in" };
  }

  const email = session.user.email.toLowerCase();
  const domain = emailDomain(email);
  const permitted =
    allowedEmails.includes(email) || (domain !== null && allowedDomains.includes(domain));

  if (!permitted) {
    return { ok: false, status: 403, error: "Not an admin" };
  }
  return { ok: true, email };
}
