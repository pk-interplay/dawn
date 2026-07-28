-- Pilot cadence: check for introductions every three hours instead of once a day.
--
-- 0017 reduced `dawn-run-matches` to a single daily run, which is the right shape for
-- a steady-state network. It is the wrong shape for a three-day pilot: one run a day
-- against a batch of three means five teammates receive roughly three introductions
-- between them per day, and nobody can tell from that whether a stream of warm intros
-- is welcome or exhausting.
--
-- Volume is governed in two independent places, and BOTH have to allow it:
--   * this schedule — how often Dawn looks (every 3h), and
--   * `people.intro_cadence` — how often any one member may be looked at
--     ('burst' = every 6h, see run-matches).
-- So the ceiling per member per day is four, and lowering either one lowers the
-- volume without touching the other. To slow the pilot down mid-flight, move members
-- back to 'daily'; the schedule can stay as it is.
--
-- `limit=10` because DEFAULT_BATCH is 3 — with five teammates plus headroom, a batch
-- of three would leave whoever sorted last waiting for the next run.
--
-- As with 0017: NOT called at migration time. Set the Vault secrets, then run
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

  -- Propose introductions every three hours, real cohort only.
  perform cron.schedule('dawn-run-matches', '0 */3 * * *', format($cron$
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

  return 'Scheduled dawn-run-matches (every 3h), dawn-decay-proximity, dawn-expire-intros.';
end;
$$;

-- Stop the pilot without touching anything else. Members keep their profiles and
-- their history; Dawn simply stops looking for new introductions to propose.
create or replace function unschedule_dawn_jobs()
returns text
language plpgsql
as $$
begin
  perform cron.unschedule(jobname)
  from cron.job
  where jobname in ('dawn-run-matches','dawn-decay-proximity','dawn-expire-intros');
  return 'Unscheduled all dawn jobs. In-flight introductions can still be replied to.';
end;
$$;
