-- Combined Dawn v1 migrations 0007–0011. Paste into the Supabase SQL editor and Run.
-- Idempotent (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).


-- ================= 0007_people_contact_scheduling =================
-- Make people contactable and schedulable.
--
-- v0 had no way to actually reach a member — Dawn drafted emails the member
-- sent by hand. For the agent to send opt-in intros and coordinate meetings
-- itself, each person needs an email address, a timezone (for proposing
-- meeting times), and controls for how often Dawn reaches out. `user_id` links
-- a person row to its Supabase auth user, closing the localStorage-only
-- identity gap; it is nullable so synthetic/seeded people and the existing flow
-- never break.
alter table people
  add column if not exists email         text,
  add column if not exists user_id       uuid,      -- references auth.users(id); nullable
  add column if not exists timezone      text,      -- IANA tz, e.g. 'America/New_York'
  add column if not exists paused        boolean not null default false,  -- opt out of new intros
  add column if not exists intro_cadence text not null default 'weekly';  -- daily | weekly | biweekly | monthly

-- Fast lookup by auth user, and by email for inbound-email → person resolution.
create index if not exists people_user_id_idx on people(user_id);
create index if not exists people_email_idx on people(lower(email));

-- ================= 0008_relationships =================
-- The professional graph + proximity-over-time core.
--
-- Distinct from `matches` (which are only *suggested* pairings the reranker
-- produced): a `relationship` is a real, ongoing connection between two members
-- with a strength that evolves. `strength` is a 0-1 "proximity" score that
-- decays as time passes since the last interaction and strengthens when new
-- interactions land — so the graph reflects who is actually close *now*, not
-- just who was ever introduced. Uses the same canonical person_low/person_high
-- generated-column + unique-pair pattern as `matches` (see 0003).
create table if not exists relationships (
  id                  uuid primary key default gen_random_uuid(),
  person_a_id         uuid not null references people(id) on delete cascade,
  person_b_id         uuid not null references people(id) on delete cascade,
  status              text not null default 'introduced',   -- introduced | connected | met | dormant
  strength            numeric(4,3) not null default 0.100,  -- 0.000-1.000 proximity
  source              text not null default 'dawn_intro',   -- dawn_intro | imported | manual
  first_connected_at  timestamptz not null default now(),
  last_interaction_at timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  person_low          uuid generated always as (least(person_a_id, person_b_id)) stored,
  person_high         uuid generated always as (greatest(person_a_id, person_b_id)) stored,
  constraint relationships_no_self check (person_a_id <> person_b_id),
  constraint relationships_status_check check (status in ('introduced','connected','met','dormant')),
  constraint relationships_source_check check (source in ('dawn_intro','imported','manual'))
);

create unique index if not exists relationships_unique_pair_idx on relationships(person_low, person_high);
create index if not exists relationships_person_a_idx on relationships(person_a_id);
create index if not exists relationships_person_b_idx on relationships(person_b_id);
create index if not exists relationships_strength_idx on relationships(strength desc);

-- Append-only timeline of relationship-affecting events. Feeds proximity.
create table if not exists interactions (
  id               uuid primary key default gen_random_uuid(),
  relationship_id  uuid references relationships(id) on delete cascade,
  person_id        uuid not null references people(id) on delete cascade,
  counterparty_id  uuid references people(id) on delete cascade,
  type             text not null,  -- intro_sent | opted_in | meeting_scheduled | meeting_completed | message
  weight           numeric(4,3) not null default 0.100,
  metadata         jsonb not null default '{}'::jsonb,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  constraint interactions_type_check check (
    type in ('intro_sent','opted_in','meeting_scheduled','meeting_completed','message'))
);

create index if not exists interactions_relationship_time_idx on interactions(relationship_id, occurred_at desc);
create index if not exists interactions_person_time_idx on interactions(person_id, occurred_at desc);

-- Recompute proximity for every relationship: exponential time-decay from the
-- last interaction (a `half_life_days`-day half-life), lifted by the summed
-- weight of interactions in the trailing 90 days. Clamped to [0,1]. Stale
-- relationships (no interaction in 120 days) fall to 'dormant'. Called by the
-- daily decay-proximity cron. Returns the number of rows updated.
create or replace function recompute_relationship_strength(half_life_days numeric default 30)
returns integer
language plpgsql
as $$
declare
  updated_count integer;
begin
  update relationships r
  set
    strength = least(1.0, greatest(0.0,
      power(0.5, extract(epoch from (now() - r.last_interaction_at)) / (half_life_days * 86400))
      + coalesce((
          select sum(i.weight) from interactions i
          where i.relationship_id = r.id and i.occurred_at > now() - interval '90 days'
        ), 0)
    )),
    status = case
      when r.last_interaction_at < now() - interval '120 days' then 'dormant'
      else r.status
    end,
    updated_at = now();
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

-- RLS intentionally left disabled for this prototype, consistent with
-- people/matches/intros. All access is via server-side keys from trusted code.

-- ================= 0009_introductions =================
-- The double opt-in workflow instance.
--
-- A `matches` row is just a *suggestion*. An `introduction` is the process of
-- actually connecting two people: Dawn emails one (or both), each opts in or
-- out, and once both are in Dawn coordinates a time. The `state` column tracks
-- exactly where each intro is. (For testing we exercise it single-sided — see
-- the INTRO_TEST_SINGLE_SIDED env flag — but the both-sided path is modeled
-- here so nothing needs reshaping to go live.)
create table if not exists introductions (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid references matches(id) on delete set null,
  person_a_id  uuid not null references people(id) on delete cascade,   -- the person Dawn is helping
  person_b_id  uuid not null references people(id) on delete cascade,   -- the person being suggested
  state        text not null default 'proposed',
  a_response   text not null default 'pending',  -- pending | yes | no
  b_response   text not null default 'pending',  -- pending | yes | no
  rationale    text,
  channel      text not null default 'email',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint introductions_no_self check (person_a_id <> person_b_id),
  constraint introductions_state_check check (state in (
    'proposed','a_invited','b_invited','a_opted_in','b_opted_in',
    'both_opted_in','scheduling','scheduled','completed','declined','expired')),
  constraint introductions_a_resp_check check (a_response in ('pending','yes','no')),
  constraint introductions_b_resp_check check (b_response in ('pending','yes','no'))
);

create index if not exists introductions_person_a_idx on introductions(person_a_id);
create index if not exists introductions_person_b_idx on introductions(person_b_id);
create index if not exists introductions_state_idx on introductions(state);
create index if not exists introductions_created_idx on introductions(created_at desc);

-- RLS intentionally left disabled for this prototype, consistent with the rest.

-- ================= 0010_conversations =================
-- Persisted agent-run email threads (the "chat conversations" layer).
--
-- Each conversation maps to an AgentMail thread. Dawn sends and receives on it;
-- every message (inbound or outbound) is stored, with `parsed` holding the
-- intent Dawn extracted from an inbound reply (did they opt in? did they
-- propose times?). This is what lets the agent pick a conversation back up
-- statefully when a reply arrives via the AgentMail webhook.
create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  introduction_id  uuid references introductions(id) on delete cascade,
  inbox_id         text,               -- AgentMail inbox id
  thread_id        text,               -- AgentMail thread id (set once the first message is sent/received)
  subject          text,
  participants     jsonb not null default '[]'::jsonb,  -- [{person_id, email, role}]
  purpose          text not null default 'opt_in',      -- opt_in | scheduling | onboarding
  state            text not null default 'open',        -- open | closed
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint conversations_purpose_check check (purpose in ('opt_in','scheduling','onboarding')),
  constraint conversations_state_check check (state in ('open','closed'))
);

create index if not exists conversations_thread_idx on conversations(thread_id);
create index if not exists conversations_introduction_idx on conversations(introduction_id);

create table if not exists messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references conversations(id) on delete cascade,
  agentmail_message_id  text,
  direction             text not null,   -- inbound | outbound
  from_email            text,
  to_emails             text[] not null default '{}',
  subject               text,
  body                  text,
  parsed                jsonb not null default '{}'::jsonb,  -- LLM-extracted intent for inbound replies
  created_at            timestamptz not null default now(),
  constraint messages_direction_check check (direction in ('inbound','outbound'))
);

create index if not exists messages_conversation_time_idx on messages(conversation_id, created_at);
create index if not exists messages_agentmail_idx on messages(agentmail_message_id);

-- RLS intentionally left disabled for this prototype, consistent with the rest.

-- ================= 0011_frequency_and_cron =================
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

-- Attempt to schedule now (no-op that returns a notice if secrets are absent).
select schedule_dawn_jobs();
