-- Frequency governance + scheduled automation.

-- How many intros / introductions / matches a person has received in a recent
-- window. Backs the `match-frequency` Edge Function and the run-matches cron's
-- per-person cap ("how often has this person received matches?").
create or replace function person_intro_stats(p_id uuid, lookback interval default interval '7 days')
returns table (intros_count bigint, introductions_count bigint, matches_count bigint)
language sql
stable
as $$
  select
    (select count(*) from intros
       where requester_ref = p_id::text and created_at > now() - lookback),
    (select count(*) from introductions
       where (person_a_id = p_id or person_b_id = p_id) and created_at > now() - lookback),
    (select count(*) from matches
       where (person_a_id = p_id or person_b_id = p_id) and created_at > now() - lookback);
$$;

-- Scheduled jobs: pg_cron fires on a schedule and pg_net POSTs to the Next.js
-- /api/cron/* routes (which reuse the app's existing matching engine). The app
-- URL and the shared CRON_SECRET are read from Vault so no secret lives in SQL.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent (re)scheduling helper. Only schedules if the required Vault
-- secrets exist, so applying this migration never fails in an environment that
-- hasn't set them yet (e.g. local dev, where cron can't reach localhost anyway).
-- Set them once, then call this function:
--   select vault.create_secret('https://your-app.example.com', 'dawn_app_url');
--   select vault.create_secret('<CRON_SECRET>', 'dawn_cron_secret');
--   select schedule_dawn_jobs();
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

  -- Find & propose matches twice a day (09:00 and 17:00 UTC).
  perform cron.schedule('dawn-run-matches', '0 9,17 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches', 'Bearer ' || secret));

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

  return 'Scheduled dawn-run-matches, dawn-decay-proximity, dawn-expire-intros.';
end;
$$;

-- NOTE: this migration deliberately does NOT call schedule_dawn_jobs(). Scheduling
-- must be an explicit, separate action taken only after the per-member cadence cap
-- is verified working — that cap counts `intros`, which RLS was silently blocking
-- until 0013. With cron live and the cap dead, every member gets re-emailed twice
-- a day. Run `select schedule_dawn_jobs();` by hand once the cap is proven.
