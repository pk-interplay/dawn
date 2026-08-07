// The local stand-in for pg_cron.
//
// `schedule_dawn_jobs()` (0019) has Postgres call the app over HTTPS, which cannot
// work against a dev server: Supabase's network egress has no route to localhost.
// For an operator-driven test the scheduler doesn't need to live in the database at
// all — it only needs to hit the same routes on the same cadence, from a machine that
// can reach them.
//
//   npm run cron:local                 # every hour, real cohort
//   INTERVAL_MINUTES=5 npm run cron:local   # tighter loop while iterating
//   COHORT=synthetic npm run cron:local     # exercise the seeded fixtures instead
//
// Fires once on startup rather than waiting out the first interval, because the
// point of starting it is usually to see something happen.
//
// Env:
//   LOCAL_APP_URL     Defaults to http://localhost:3000. NOT read from APP_URL — that
//                     one has to keep pointing at the public tunnel for AgentMail's
//                     webhook to deliver replies, and pointing it at localhost to
//                     satisfy this script would silently break the inbound leg.
//   CRON_SECRET       Same value the app checks in app/lib/authz.ts.
//   INTERVAL_MINUTES  Defaults to 60.
//   BATCH             Passed through as ?limit=. Defaults to 10.
//   COHORT            'real' (default) or 'synthetic'.

import "../lib/env";

const APP = (process.env.LOCAL_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const INTERVAL_MIN = Number(process.env.INTERVAL_MINUTES ?? 60);
const BATCH = Number(process.env.BATCH ?? 10);
const SYNTHETIC = process.env.COHORT === "synthetic";

if (!SECRET) {
  // isAuthorized() denies every request when this is unset, so without it the loop
  // would run all day collecting 401s.
  console.error("CRON_SECRET is not set — every request would 401. Add it to .env.local.");
  process.exit(1);
}

/** Hour-of-day in UTC, matching how the daily jobs are scheduled in 0019. */
const DECAY_AT_UTC_HOUR = 3;
const EXPIRE_AT_UTC_HOUR = 4;

let lastDailyRunDate = "";

async function call(path: string): Promise<void> {
  const url = `${APP}${path}`;
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    });
    const text = await res.text();

    // A dev server that has recompiled, or a route that threw, returns HTML. Printing
    // the raw body for that case is more useful than a JSON parse error.
    let summary = text.slice(0, 400);
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      summary = JSON.stringify(json, null, 2);
    } catch {
      /* keep the truncated body */
    }
    console.log(`\n[${startedAt}] POST ${path} → ${res.status}\n${summary}`);
  } catch (err) {
    // Almost always "dev server isn't running". Keep looping: it may come back.
    console.error(
      `\n[${startedAt}] POST ${path} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function tick(): Promise<void> {
  await call(`/api/cron/run-matches?synthetic=${SYNTHETIC}&limit=${BATCH}`);

  // decay-proximity and expire-intros used to be folded in here so a local run
  // matched a scheduled deployment. Migration 0031 unschedules both — with the email
  // layer gone, `relationships` has no writer and `introductions` no longer grows, so
  // each was decaying or sweeping a frozen table. Nothing to mirror any more.
}

console.log(
  `Dawn local cron → ${APP}\n` +
    `  every ${INTERVAL_MIN} min · cohort=${SYNTHETIC ? "synthetic" : "real"} · limit=${BATCH}\n` +
    `  Ctrl-C to stop. Introductions stay repliable after it stops.\n`,
);

await tick();
setInterval(() => void tick(), INTERVAL_MIN * 60_000);
