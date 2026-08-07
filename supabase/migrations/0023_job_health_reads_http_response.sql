-- Recovered from production (remote migration version 20260728210315,
-- applied 2026-07-28, name "0023_job_health_reads_http_response") — this file
-- was applied to the live database but never committed to the repo. Recovered
-- verbatim from supabase_migrations.schema_migrations.statements while
-- investigating a migration-history/local-files mismatch during the Nexus
-- v0.2 claims-model work; see SPEC.md's "Open risks" table: "Cron silently
-- failing — pg_net is asynchronous, so cron.job_run_details reports
-- 'succeeded' for a call that returned 401. Reuse dawn_job_health(), which
-- reads net._http_response directly."
drop function if exists dawn_job_health();

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
