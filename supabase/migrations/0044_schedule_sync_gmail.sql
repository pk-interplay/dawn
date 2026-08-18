-- Teach schedule_dawn_jobs() about the incremental Gmail sync.
--
-- The work lives in syncGmailForAccount() (src/lib/gmail-sync.ts) behind
-- /api/cron/sync-gmail, an isAuthorized-gated trigger shaped like the other
-- /api/cron/* routes. Idempotent by construction: every graph write is an
-- upsert, the per-mailbox claim row prevents concurrent reads, and the history
-- cursor only advances after a successful write — a double-fire re-fetches and
-- re-upserts, never duplicates.
--
-- Redefines the whole function rather than calling cron.schedule directly, for
-- the reason 0031/0033/0037 all give: schedule_dawn_jobs() is the single source
-- of truth an operator runs to (re)establish the schedule. Existing jobs are
-- carried forward unchanged.
--
-- Hourly at :40 — offset from run-matches (:00) and nudge-intros (:20) so the
-- three never contend for the same function budget or, later, the same inbox.
--
-- Unchanged from 0022 onward and still load-bearing: NOT called at migration
-- time. Set the Vault secrets, then `select schedule_dawn_jobs();` once
-- `dawn_app_url` is actually reachable.

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
    'dawn-reconcile-companies','dawn-nudge-intros','dawn-sync-gmail'
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

  -- Keep every onboarded mailbox's graph current: history-delta Gmail read plus a
  -- bounded calendar window, oldest-synced accounts first. The route slices its own
  -- time budget, so an hour with many due accounts converges over successive runs.
  perform cron.schedule('dawn-sync-gmail', '40 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/sync-gmail', 'Bearer ' || secret));

  return 'Scheduled dawn-run-matches (hourly), dawn-nudge-intros (every 6h at :20), '
      || 'dawn-reconcile-companies (daily 03:30 UTC) and dawn-sync-gmail (hourly at :40). '
      || 'decay-proximity and expire-intros remain intentionally unscheduled — see 0031.';
end;
$$;
