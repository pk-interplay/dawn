import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set");
}

// Read-only client for the app's API routes. RLS is currently disabled on
// `people`/`matches`, so the publishable key can read everything; it cannot
// do anything the service-role scripts (seed/match) can't already do.
export const db = createClient(url, key);
