-- Introductions Dawn (the agent) has actually made — an append-only event log.
--
-- Distinct from `matches`, which are *suggested* pairings the reranker produced.
-- An intro is a discrete action taken on behalf of a requester, timestamped so
-- we can rate-limit it. This is what enforces "one introduction per person per
-- day" in real code rather than only in the SOUL.md persona prompt.
--
-- The rate-limited subject is `requester_ref`: a stable identifier for the
-- person Dawn is helping (e.g. a Telegram user id/handle, or a people.id). It
-- is intentionally free-form text so the limit works even for people who are
-- not (yet) rows in `people`.
create table if not exists intros (
  id                uuid primary key default gen_random_uuid(),
  requester_ref     text not null,
  introduced_to_id  uuid not null references people(id) on delete cascade,
  rationale         text,
  channel           text,                 -- e.g. 'telegram', 'cli'
  created_at        timestamptz not null default now()
);

-- Supports the "how many intros has this requester had today?" lookup.
create index if not exists intros_requester_time_idx
  on intros (requester_ref, created_at desc);

-- RLS intentionally left disabled for this prototype, consistent with
-- people/matches. All access is via the service-role key from trusted code.
