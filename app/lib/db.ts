import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

// Service-role client for the app's API routes (server-only — never import this
// from a client component). The publishable key is dead: migration 0041 enabled
// RLS with zero policies on every table and revoked anon/authenticated grants, so
// the anon role can read and write nothing. Every route that reaches the DB is
// auth-gated in code (requireUser / requireAdmin / isAuthorized /
// isInboundAuthorized) — that is the enforcement boundary.
export const db = createClient(url, key, { auth: { persistSession: false } });
