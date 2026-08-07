-- Schedule company reconciliation: promote work-email domains that cross the
-- people threshold to organization entities and enrich them via Exa.
--
-- The work lives in src/lib/reconcile-companies.ts behind /api/cron/reconcile-
-- companies, a thin isAuthorized-gated trigger shaped exactly like the other
-- /api/cron/* routes. This migration only teaches schedule_dawn_jobs() about the
-- new job; it is idempotent (orgs de-dupe on their domain claim, edges on their
-- unique key, Exa is skipped for already-enriched orgs) so a daily cadence is safe.
--
-- Redefines schedule_dawn_jobs() rather than calling cron.schedule directly, for
-- the same reason 0031 did: that function is the single source of truth an operator
-- runs to (re)establish the schedule, and it would otherwise drop this job on the
-- next run. Everything about dawn-run-matches is carried forward unchanged.
--
-- Unchanged from 0022/0031 and still load-bearing: NOT called at migration time.
-- Set the Vault secrets, then `select schedule_dawn_jobs();` once the URL in
-- `dawn_app_url` is actually reachable — a job pointed at an unreachable URL fails
-- silently and only net._http_response records it (see dawn_job_health()).

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

  -- Clear every name this function has ever owned, so re-running after an older
  -- migration's version leaves no orphans behind.
  perform cron.unschedule(jobname)
  from cron.job
  where jobname in (
    'dawn-run-matches','dawn-decay-proximity','dawn-expire-intros','dawn-reconcile-companies'
  );

  -- Propose introductions every hour, real cohort only. `synthetic=false` keeps the
  -- 19 seeded @example.com fixtures out; without it the hourly run would generate
  -- introductions to people who do not exist.
  perform cron.schedule('dawn-run-matches', '0 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches?synthetic=false&limit=10', 'Bearer ' || secret));

  -- Reconcile companies once a day (03:30 UTC). Idempotent and cost-guarded, so the
  -- daily run only pays Exa for domains that newly crossed the threshold.
  perform cron.schedule('dawn-reconcile-companies', '30 3 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/reconcile-companies', 'Bearer ' || secret));

  return 'Scheduled dawn-run-matches (hourly) and dawn-reconcile-companies (daily 03:30 UTC). '
      || 'decay-proximity and expire-intros remain intentionally unscheduled — see 0031.';
end;
$$;
