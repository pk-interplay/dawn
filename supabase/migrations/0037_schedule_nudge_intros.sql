-- Teach schedule_dawn_jobs() about the follow-up sweep.
--
-- The work lives in nudgeIntroduction() (src/lib/intro-flow.ts) behind
-- /api/cron/nudge-intros, an isAuthorized-gated trigger shaped like the other
-- /api/cron/* routes. Idempotent by construction: the route only touches rows whose
-- next_action_at has come due, and every path through nudgeIntroduction either
-- re-arms that column or clears it, so a double-fire cannot double-send.
--
-- Redefines the whole function rather than calling cron.schedule directly, for the
-- reason 0031 and 0033 both give: schedule_dawn_jobs() is the single source of truth
-- an operator runs to (re)establish the schedule, so a job added outside it would be
-- dropped on the next run. dawn-run-matches and dawn-reconcile-companies are carried
-- forward unchanged.
--
-- Every six hours, not hourly. The nudge delays are measured in days (+3d, then +4d),
-- so the sweep's only job is to notice a due row within a few hours of it becoming
-- due; running it hourly would mean 24 no-op passes a day to gain resolution nobody
-- can perceive in an email that was always going to say "just checking".
--
-- Unchanged from 0022/0031/0033 and still load-bearing: NOT called at migration time.
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
    'dawn-run-matches','dawn-decay-proximity','dawn-expire-intros',
    'dawn-reconcile-companies','dawn-nudge-intros'
  );

  -- Propose introductions every hour, real cohort only. `synthetic=false` keeps the
  -- 19 seeded @example.com fixtures out; without it the hourly run would generate
  -- introductions to people who do not exist.
  perform cron.schedule('dawn-run-matches', '0 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches?synthetic=false&limit=10', 'Bearer ' || secret));

  -- Follow up on unanswered opt-in asks, and retire the ones out of allowance.
  -- Offset to :20 so it never contends with the top-of-hour matching run for the
  -- same AgentMail inbox.
  perform cron.schedule('dawn-nudge-intros', '20 */6 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/nudge-intros', 'Bearer ' || secret));

  -- Reconcile companies once a day (03:30 UTC). Idempotent and cost-guarded, so the
  -- daily run only pays Exa for domains that newly crossed the threshold.
  perform cron.schedule('dawn-reconcile-companies', '30 3 * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/reconcile-companies', 'Bearer ' || secret));

  return 'Scheduled dawn-run-matches (hourly), dawn-nudge-intros (every 6h at :20) and '
      || 'dawn-reconcile-companies (daily 03:30 UTC). decay-proximity and expire-intros '
      || 'remain intentionally unscheduled — see 0031. expire-intros is now only a '
      || 'backstop; nudge-intros owns retirement.';
end;
$$;
