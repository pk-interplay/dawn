-- Drop two cron jobs that became permanent no-ops when the email layer was
-- removed. `dawn-run-matches` stays — matching is still the product.
--
-- Why these two are now no-ops:
--
--   dawn-expire-intros  — sweeps `introductions` rows nobody opted into. After the
--     email removal there are zero callers of startIntroduction() (the send call in
--     run-matches is gone and /api/admin/intro is deleted), so `introductions` never
--     grows again and the 04:00 sweep has nothing to find. The route and the table
--     both stay: the intro state machine is deliberately kept in the repo, dark, to
--     be rewired to another channel later.
--
--   dawn-decay-proximity — recomputes `relationships.strength`. In production that
--     table was only ever written by intro-flow.ts (upsertRelationship) and the seed
--     script, so with intro-flow dark it is frozen and the nightly job decays a
--     static table. The route AND recompute_relationship_strength() both stay:
--     SPEC §2.3 explicitly says to reuse that function for time decay when the
--     claims-model equivalent is built, and deleting it would contradict the spec.
--     `edges.strength` already applies a 90-day half-life at write time
--     (network-ingest.ts), so nothing is currently un-decayed; a real edges decay
--     cron is SPEC step 6.
--
-- Doing this as a migration rather than a manual `select cron.unschedule(...)`:
-- schedule state that lives only in someone's psql history is state nobody can
-- reproduce. And per 0022's own findings, a failing pg_net call is invisible in
-- cron.job_run_details — a job left scheduled against a route that no longer does
-- anything just adds noise to dawn_job_health() forever.
--
-- Safe to run before or after the app deploy: unscheduling a job that was never
-- scheduled is a no-op here, since the delete is driven off cron.job itself.

do $$
begin
  -- pg_cron may not be installed in a fresh local/branch database. Nothing to
  -- unschedule there, and this must not fail the migration.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; nothing to unschedule.';
    return;
  end if;

  perform cron.unschedule(jobname)
  from cron.job
  where jobname in ('dawn-decay-proximity', 'dawn-expire-intros');
end;
$$;

-- Keep schedule_dawn_jobs() honest: it is the function an operator calls to
-- (re)establish the schedule, and it would otherwise put both jobs straight back.
-- Redefined here to schedule only dawn-run-matches.
--
-- Unchanged from 0022 and still load-bearing: NOT called at migration time. Set the
-- Vault secrets, then `select schedule_dawn_jobs();` once the URL in `dawn_app_url`
-- is actually reachable — a job pointed at an unreachable URL fails silently every
-- hour and only net._http_response records it (see dawn_job_health()).
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

  -- Still clears all three names, so re-running this after an older migration's
  -- version has run leaves no orphans behind.
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

  return 'Scheduled dawn-run-matches (hourly). decay-proximity and expire-intros are '
      || 'intentionally unscheduled — see 0031.';
end;
$$;

-- unschedule_dawn_jobs() from 0011 already targets all three names by string, so it
-- needs no change.
