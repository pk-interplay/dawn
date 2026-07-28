-- One introduction run per day, and only for the real cohort.
--
-- Two corrections to the schedule defined in 0011:
--
-- 1. `dawn-run-matches` fired at 09:00 AND 17:00 UTC. Combined with the per-member
--    `intro_cadence` cap that is not twice the volume, but it does mean a member on
--    'daily' can receive two intros in a calendar day, and it doubles the cost of
--    every run. A daily sequence should run daily.
--
-- 2. The run now targets `is_synthetic = false` explicitly. The route already
--    defaults to the real cohort, but the cron URL should say so out loud — the
--    seeded personas' @example.com addresses are rewritten by MAIL_REDIRECT_TO, so a
--    run that swept them would bury the operator's own inbox.
--
-- Still deliberately NOT called at migration time. Set the Vault secrets and run
-- `select schedule_dawn_jobs();` by hand once the deployed URL is reachable.
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

  -- Propose introductions once a day (08:00 UTC), real cohort only.
  perform cron.schedule('dawn-run-matches', '0 8 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches?synthetic=false', 'Bearer ' || secret));

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

  return 'Scheduled dawn-run-matches (daily 08:00 UTC), dawn-decay-proximity, dawn-expire-intros.';
end;
$$;
