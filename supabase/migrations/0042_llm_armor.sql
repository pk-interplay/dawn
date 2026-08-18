-- 0042: failed sends become visible, and model spend becomes countable.

-- ---------------------------------------------------------------------------
-- 1. sends: 'failed' is a real state, distinct from draft.
-- ---------------------------------------------------------------------------
-- 0039's CHECK had no 'failed', so markFailed could only write failure_reason
-- while the row sat at status='draft' forever. Consequences: a permanently
-- failed send was indistinguishable from a deliberately-held draft in the
-- Outbox review queue, and RUNBOOK step 10's `delete from sends where status =
-- 'draft'` destroyed the evidence of every failed send. It also blocked
-- retries: the idempotency index on (introduction_id, kind, attempt) made the
-- failed row permanently claim its slot — the gateway's 23505 branch now treats
-- a prior 'failed' row as re-usable (see send-gateway.ts).
--
-- 0039 declared the CHECK inline on the column, so the auto-generated name is
-- sends_status_check. The rate-limit partial index in 0039 filters on
-- ('queued','sent','bounced','replied'), so 'failed' rows correctly do not
-- count against sending volume.
alter table sends drop constraint if exists sends_status_check;
alter table sends add constraint sends_status_check check (status in
  ('draft','queued','sent','bounced','replied','suppressed','failed'));

-- Rows that already tried and failed are drafts only by accident of the old
-- CHECK. Reclassify them so the Outbox stops mixing the two.
update sends set status = 'failed'
  where status = 'draft' and failure_reason is not null;

-- ---------------------------------------------------------------------------
-- 2. Model spend ledger (written by src/lib/llm.ts logLLMUsage, best-effort).
-- ---------------------------------------------------------------------------
-- Answers "what did the hourly run cost" (sum by run_id) and "is prompt caching
-- engaged" (cache_read_tokens > 0). Deliberately minimal: no FK anywhere, no
-- prices — token counts age better than dollar math baked into rows.
create table if not exists llm_usage (
  id                 bigserial primary key,
  site               text not null,      -- 'matchmaker' | 'chat' | 'rerank' | ...
  model              text not null,
  run_id             text,               -- cron runId / chat threadId / null
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  duration_ms        integer,
  created_at         timestamptz not null default now()
);
create index if not exists llm_usage_run_idx on llm_usage (run_id);
create index if not exists llm_usage_site_time_idx on llm_usage (site, created_at);

-- Same posture as 0041: service-role only.
alter table llm_usage enable row level security;
revoke all on table llm_usage from anon, authenticated;
revoke all on sequence llm_usage_id_seq from anon, authenticated;
