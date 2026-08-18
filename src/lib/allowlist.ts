// Sign-in allowlist — who is allowed through the front door at all.
//
// Deliberately separate from ADMIN_EMAILS / ADMIN_EMAIL_DOMAINS (app/lib/admin-auth.ts):
// admins are a subset of members, and conflating the two lists would make every pilot
// member an operator. Same deny-by-default posture: both vars unset means nobody
// signs in.
//
//   ALLOWED_EMAIL_DOMAINS — Workspace domains, e.g. "interplay.vc". Matched ONLY via
//                           Google's `hd` (hosted-domain) claim, which Google asserts
//                           exclusively for Workspace accounts — so it cannot be
//                           satisfied by a lookalike address, a quoted local part, or
//                           a consumer account. Never matched against the email
//                           suffix; that would reopen both holes.
//   ALLOWED_EMAILS        — individual addresses (case-insensitive), the escape hatch
//                           for hand-picked members outside those domains, including
//                           personal @gmail.com accounts.
//
// OAuth-client interaction (see .env.example): the Google OAuth client can stay
// "Internal" (Workspace-only, no verification/CASA) only while every member is in the
// Interplay Workspace. The moment a personal-gmail member is added via ALLOWED_EMAILS,
// the client must be "External" — this list is enforced app-side either way, but the
// client type is a Google-console decision the operator makes consciously.

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedSignIn(p: {
  email?: string | null;
  /** Google's `email_verified` claim. Only an explicit false denies. */
  emailVerified?: boolean | null;
  /** Google's `hd` (Workspace hosted-domain) claim. */
  hd?: string | null;
}): boolean {
  const emails = splitList(process.env.ALLOWED_EMAILS);
  // Tolerate "@interplay.vc" as well as "interplay.vc", like admin-auth does.
  const domains = splitList(process.env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
  if (!emails.length && !domains.length) return false; // fail closed

  const email = p.email?.toLowerCase();
  if (!email || p.emailVerified === false) return false;

  if (emails.includes(email)) return true;

  return !!p.hd && domains.includes(p.hd.toLowerCase());
}
