// Configure Supabase Auth email: Resend as custom SMTP + the redirect URLs the
// password-reset link is allowed to return to.
//
//   npx tsx src/scripts/configure-auth.ts            # show what's set now (no writes)
//   npx tsx src/scripts/configure-auth.ts --apply     # write it
//
// Why a script and not the dashboard: both settings are easy to get subtly wrong and
// the failure is silent. A reset link whose target is missing from the allow list is
// rewritten to the site root with no tokens, so /reset-password renders "this link
// isn't valid" for every user — indistinguishable from an expired link. Keeping the
// desired state here means it can be re-applied after a project restore.
//
// This PATCHes only the keys below. It deliberately does NOT touch mailer_autoconfirm:
// signup confirmation is off on this project by choice (no SMTP at the time), and
// flipping it on would block every new account behind an email nobody reads yet.
import "../lib/env";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const resendKey = process.env.RESEND_API_KEY;
const senderEmail = process.env.AUTH_SENDER_EMAIL;
const senderName = process.env.AUTH_SENDER_NAME ?? "Dawn";
const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

if (!token) {
  throw new Error(
    "SUPABASE_ACCESS_TOKEN must be set (Supabase dashboard → Account → Access Tokens, sbp_…)",
  );
}

// The project ref is the first label of the Supabase URL host.
const ref = new URL(process.env.SUPABASE_URL ?? "").hostname.split(".")[0];
if (!ref) throw new Error("SUPABASE_URL must be set so the project ref can be derived");

const API = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// Every URL a Supabase auth email is allowed to send the browser back to. Wildcards
// cover Vercel preview deployments, which get a fresh hostname per push.
const redirectUrls = [
  `${appUrl}/reset-password`,
  `${appUrl}/login`,
  "http://localhost:3000/reset-password",
  "http://localhost:3000/login",
  ...(process.env.AUTH_PREVIEW_URL_PATTERN ? [process.env.AUTH_PREVIEW_URL_PATTERN] : []),
];

const apply = process.argv.includes("--apply");

const current = await fetch(API, { headers });
if (!current.ok) throw new Error(`GET config/auth failed: ${current.status} ${await current.text()}`);
const before = (await current.json()) as Record<string, unknown>;

console.log("current:");
for (const key of [
  "site_url",
  "uri_allow_list",
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_admin_email",
  "smtp_sender_name",
  "mailer_autoconfirm",
  "rate_limit_email_sent",
]) {
  console.log(`  ${key} = ${JSON.stringify(before[key] ?? null)}`);
}

if (!apply) {
  console.log("\nre-run with --apply to write the values above to Resend SMTP + redirect URLs");
  process.exit(0);
}

if (!resendKey) throw new Error("RESEND_API_KEY must be set — it is the SMTP password");
if (!senderEmail) {
  throw new Error(
    "AUTH_SENDER_EMAIL must be set to an address on a domain verified in Resend " +
      "(e.g. no-reply@yourdomain.com). Resend rejects mail from unverified domains.",
  );
}

const body = {
  site_url: appUrl,
  // Comma-separated, per the Management API.
  uri_allow_list: redirectUrls.join(","),
  smtp_host: "smtp.resend.com",
  smtp_port: "465",
  // Resend's SMTP username is the literal string "resend"; the API key is the password.
  smtp_user: "resend",
  smtp_pass: resendKey,
  smtp_admin_email: senderEmail,
  smtp_sender_name: senderName,
  // Supabase caps auth email at 2/hour on its built-in mailer. With our own SMTP that
  // limit is ours to set, and 2/hour makes password reset unusable for a cohort.
  rate_limit_email_sent: 100,
};

const res = await fetch(API, { method: "PATCH", headers, body: JSON.stringify(body) });
if (!res.ok) throw new Error(`PATCH config/auth failed: ${res.status} ${await res.text()}`);

console.log("\napplied:");
console.log(`  smtp: smtp.resend.com:465 as "resend", from ${senderName} <${senderEmail}>`);
console.log(`  site_url: ${appUrl}`);
for (const url of redirectUrls) console.log(`  redirect: ${url}`);
console.log("\nSend yourself a reset from /forgot-password to confirm delivery.");
