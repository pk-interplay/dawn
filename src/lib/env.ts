// Environment loading for the CLI scripts (seed, demo-personas, match, mcp).
//
// `import "dotenv/config"` reads `.env` only. Next.js reads `.env.local` — which is
// where this project's config actually lives — so anything run through tsx saw an
// empty environment and died on "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be
// set" while the app itself worked fine. Same repo, same keys, different loader.
//
// Paths are resolved from this file rather than the cwd, because an MCP client can
// spawn us from anywhere. `.env.local` is listed first because dotenv keeps the
// first value it sees for a given key: local overrides shared, and anything already
// exported in the shell wins over both.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

dotenv.config({
  path: [resolve(ROOT, ".env.local"), resolve(ROOT, ".env")],
  quiet: true,
});
