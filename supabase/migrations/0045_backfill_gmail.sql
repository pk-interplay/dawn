-- Shallow-first onboarding + background Gmail backfill.
--
-- Onboarding now reads only the last 30 days interactively (a ~10s wait instead
-- of ~80s); the rest of the 6-month window is drained by dawn-backfill-gmail
-- (src/lib/gmail-backfill.ts behind /api/cron/backfill-gmail) via a moving
-- cursor. Idempotent by construction, same argument as 0044: every graph write
-- is an upsert, the per-mailbox claim row prevents concurrent reads, and the
-- cursor only advances after a successful write.
--
-- The remaining window is [backfill_until, backfill_before): the onboarding
-- release seeds both (until = onboarding time − 6 months, before = the shallow
-- window's start), each backfill pass walks backfill_before backwards, and a
-- drained listing clears it — which is also when last_full_ingest_at is set.
-- That column was previously written by onboarding and read by nothing
-- (verified before repurposing); its meaning is now "the full lookback window
-- is in the graph". Accounts onboarded before this migration have a null
-- cursor and are simply skipped — they already had the full ingest.

alter table gmail_sync_state add column if not exists backfill_before timestamptz;
alter table gmail_sync_state add column if not exists backfill_until timestamptz;

-- The backfill fan-out: least-recently-touched accounts with work remaining.
create index if not exists gmail_sync_state_backfill_due
  on gmail_sync_state (updated_at asc) where backfill_before is not null;

-- Redefines the whole function rather than calling cron.schedule directly, for
-- the reason 0031/0033/0037/0044 all give: schedule_dawn_jobs() is the single
-- source of truth an operator runs to (re)establish the schedule. Existing jobs
-- are carried forward unchanged.
--
-- Hourly at :10 — its own minute slot, offset from run-matches (:00),
-- nudge-intros (:20) and sync-gmail (:40). Backfill and sync also share the
-- per-mailbox claim row, so even a slow pass can only make the other skip,
-- never double-read one mailbox.
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
    'dawn-reconcile-companies','dawn-nudge-intros','dawn-sync-gmail',
    'dawn-backfill-gmail'
  );

  -- Propose introductions every hour, real cohort only. `synthetic=false` keeps the
  -- 19 seeded @example.com fixtures out; without it the hourly run would generate
  -- introductions to people who do not exist.
  perform cron.schedule('dawn-run-matches', '0 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/run-matches?synthetic=false&limit=10', 'Bearer ' || secret));

  -- Drain each onboarded mailbox's pre-shallow-window history, newest first,
  -- one paced quota-minute per account per pass. Selects accounts with a live
  -- backfill_before cursor; a drained account leaves the rotation for good.
  perform cron.schedule('dawn-backfill-gmail', '10 * * * *', format($cron$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','Authorization',%L)
    );$cron$, app_url || '/api/cron/backfill-gmail', 'Bearer ' || secret));

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

  return 'Scheduled dawn-run-matches (hourly), dawn-backfill-gmail (hourly at :10), '
      || 'dawn-nudge-intros (every 6h at :20), dawn-reconcile-companies (daily 03:30 UTC) '
      || 'and dawn-sync-gmail (hourly at :40). '
      || 'decay-proximity and expire-intros remain intentionally unscheduled — see 0031.';
end;
$$;
