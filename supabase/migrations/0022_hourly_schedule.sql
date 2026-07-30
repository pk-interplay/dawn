-- Hourly introductions, for an operator-driven test.
--
-- 0019 moved the pilot to every three hours, reasoning that a three-day test on a
-- daily schedule delivers too little to judge. The same argument taken one step
-- further: when the operator is playing BOTH sides of the network from their own
-- inboxes, the constraint is no longer the recipient's patience, it's how fast the
-- operator can reply. Hourly lets the whole lifecycle — propose, opt in, second-side
-- opt in, schedule, record proximity — be exercised several times in an afternoon.
--
-- Both gates have to allow it, and they are still independent (see 0019):
--   * this schedule — how often Dawn looks (now every hour), and
--   * `people.intro_cadence` — how often any one member may be looked at.
-- The matching tier that permits hourly is 'hourly' (CADENCE_DAYS in run-matches),
-- which onboarding deliberately does NOT offer: SELECTABLE_CADENCES omits it, so a
-- colleague can never tick their way into 24 asks a day. Only a row set by hand — the
-- operator's own — is ever looked at hourly. Everyone else stays on the cadence they
-- chose, and this schedule simply checks them more often than it needs to.
--
-- Unchanged from 0019, and load-bearing: NOT called at migration time. Set the Vault
-- secrets, then `select schedule_dawn_jobs();` once the URL in `dawn_app_url` is
-- actually reachable. A scheduled job pointed at an unreachable URL fails silently
-- every hour — pg_cron records the failure in cron.job_run_details and nothing else
-- tells you.
create or replace function schedule_dawn_jobs()
returns text
language plpgsql
as $$
declare
  app_url text;
  secret  text;
begin
  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'dawn_app_url';
  select decrypted_secret into secret  from vault.decrypted_secrets where name = 'dawn_cron_secret';
  if app_url is null or secret is null then
    return 'Skipped: set vault secrets dawn_app_url and dawn_cron_secret, then call schedule_dawn_jobs().';
  end if;

  perform cron.unschedule(jobname)
  from cron.job
  where jobname in ('dawn-run-matches','dawn-decay-proximity','dawn-expire-intros');

  -- Propose introductions every hour, real cohort only. `synthetic=false` keeps the
  -- 19 seeded @example.com fixtures out; without it the hourly run would generate
  -- introductions to people who do not exist.
  perform cron.schedule('dawn-run-matches', '0 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches?synthetic=false&limit=10', 'Bearer ' || secret));

  -- Recompute relationship proximity once a day (03:00 UTC).
  perform cron.schedule('dawn-decay-proximity', '0 3 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/decay-proximity', 'Bearer ' || secret));

  -- Expire introductions nobody opted into once a day (04:00 UTC).
  perform cron.schedule('dawn-expire-intros', '0 4 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/expire-intros', 'Bearer ' || secret));

  return 'Scheduled dawn-run-matches (hourly), dawn-decay-proximity, dawn-expire-intros.';
end;
$$;

-- Did the hourly job actually reach the app?
--
-- Two traps make the obvious version of this useless, and both were observed on the
-- first live run:
--
--   1. `net.http_post` is ASYNCHRONOUS. pg_cron records the enqueue, so
--      cron.job_run_details said `succeeded` for a call that came back 401. The HTTP
--      result lives in net._http_response, and that is the only place it exists.
--   2. Joining cron.job_run_details to cron.job on jobid loses everything on a
--      reschedule: schedule_dawn_jobs() unschedules first, the old jobid disappears,
--      and the join silently drops the very history you came to read.
--
-- So: read the response table directly, and don't join to cron.job at all.
create or replace function dawn_job_health()
returns table (at timestamptz, status_code integer, verdict text, body text)
language sql
as $$
  select
    r.created,
    r.status_code,
    case
      when r.status_code between 200 and 299 then 'ok'
      when r.content ilike '%vercel_auth_enabled%' or r.content ilike '%sso-api%'
        then 'blocked by Vercel access protection — dawn_app_url points at a protected deployment'
      when r.status_code = 401 then 'unauthorized — dawn_cron_secret does not match the app CRON_SECRET'
      when r.status_code in (301,302,307,308) then 'redirected — pg_net does not follow redirects, so nothing ran'
      else 'failed'
    end,
    left(coalesce(r.content, ''), 200)
  from net._http_response r
  order by r.created desc
  limit 20;
$$;
