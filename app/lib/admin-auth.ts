import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

// Allowlist gate for the read-only monitoring routes (/api/admin/monitor/*).
// The browser sends its Supabase session token as a Bearer header; we verify it
// server-side and check the resulting email against two allowlists:
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

export async function requireAdmin(req: Request): Promise<AdminCheck> {
  const allowedEmails = adminEmails();
  const allowedDomains = adminDomains();
  if (!allowedEmails.length && !allowedDomains.length) {
    return {
      ok: false,
      status: 503,
      error: "Set ADMIN_EMAIL_DOMAINS or ADMIN_EMAILS to open the monitor",
    };
  }
  if (!url || !key) {
    return { ok: false, status: 503, error: "Supabase env vars are not configured" };
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  // getUser(token) validates the JWT against the auth server rather than trusting
  // the claims, so an expired or forged token fails here.
  const { data, error } = await createClient(url, key).auth.getUser(token);
  if (error || !data.user?.email) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const email = data.user.email.toLowerCase();
  const domain = emailDomain(email);
  const permitted =
    allowedEmails.includes(email) || (domain !== null && allowedDomains.includes(domain));

  if (!permitted) {
    return { ok: false, status: 403, error: "Not an admin" };
  }
  return { ok: true, email };
}
