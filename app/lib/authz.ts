import { timingSafeEqual } from "node:crypto";

// Shared-secret gates for the automation surfaces. Two secrets on purpose:
//
//  - CRON_SECRET            — pg_cron → /api/cron/*. Lives in the Vercel env AND in
//                             Supabase Vault ('dawn_cron_secret'); rotating it means
//                             updating both and re-running `select schedule_dawn_jobs();`.
//  - INBOUND_WEBHOOK_SECRET — AgentMail webhook → /api/agent/inbound. Lives in the
//                             Vercel env and in the AgentMail webhook's custom headers
//                             only, so it rotates without touching Vault or pg_cron —
//                             and a leaked cron secret can no longer forge inbound mail.
//
// Either secret unset = that surface is closed (deny by default).

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length is not secret; contents are. timingSafeEqual throws on length mismatch,
  // so gate it — the early return leaks only length.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearerMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), secret);
}

export function isAuthorized(req: Request): boolean {
  return bearerMatches(req, process.env.CRON_SECRET);
}

export function isInboundAuthorized(req: Request): boolean {
  return bearerMatches(req, process.env.INBOUND_WEBHOOK_SECRET);
}
