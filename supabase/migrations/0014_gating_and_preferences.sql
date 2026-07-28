-- Inbound gating + evolving preferences.
--
-- Two problems this addresses.
--
-- GATING. Dawn's inbox had no boundary: no membership check, no rate limit, no
-- replay protection, and no notion of "that isn't something I do". Worse, the
-- expensive LLM classification ran *before* the sender was resolved to a member,
-- so an unknown sender could burn tokens. `inbound_events` is the substrate for
-- all of it — one row per inbound email, actioned or not, which simultaneously
-- serves as the idempotency key, the rate-limit counter, and the audit trail.
--
-- INTELLIGENCE. Matching only ever saw a person's static profile plus accepted/
-- rejected `matches` rows. It never saw *why* someone declined, or anything they
-- said in an email. `person_preferences` captures durable signal — stated or
-- inferred — with provenance, so a bad inference is traceable and revocable
-- rather than silently poisoning future matches.

-- ---------------------------------------------------------------------------
-- Every inbound email, whether or not we acted on it.
-- ---------------------------------------------------------------------------
create table if not exists inbound_events (
  id                    uuid primary key default gen_random_uuid(),
  agentmail_message_id  text,          -- idempotency key; null for synthetic/test payloads
  thread_id             text,
  from_email            text not null,
  subject               text,
  body                  text,
  person_id             uuid references people(id) on delete set null,  -- null => not a member
  conversation_id       uuid references conversations(id) on delete set null,
  decision              text not null,
  classification        jsonb not null default '{}'::jsonb,  -- the LLM's read, when we paid for one
  replied               boolean not null default false,
  created_at            timestamptz not null default now(),
  constraint inbound_events_decision_check check (decision in (
    'reply_to_intro',     -- a member replying inside a live introduction
    'preference_update',  -- a member telling us something durable about their preferences
    'pause',              -- a member asking us to stop
    'out_of_scope',       -- a member asking for something Dawn doesn't do
    'non_member',         -- sender isn't in `people`
    'rate_limited',       -- sender exceeded their window
    'duplicate',          -- webhook replay of a message we already processed
    'self_send'           -- our own inbox; loop guard
  ))
);

-- Replay protection. Partial (null id => synthetic payload, not deduped).
create unique index if not exists inbound_events_message_idx
  on inbound_events(agentmail_message_id)
  where agentmail_message_id is not null;

-- Backs the per-sender rate-limit count.
create index if not exists inbound_events_sender_time_idx
  on inbound_events(lower(from_email), created_at desc);
create index if not exists inbound_events_decision_time_idx
  on inbound_events(decision, created_at desc);

-- ---------------------------------------------------------------------------
-- Waitlist capture for non-members who email in.
-- ---------------------------------------------------------------------------
-- `invited_at` is the one-and-only-invite gate: a non-member gets exactly one
-- reply ever, no matter how many times they write. Without that, Dawn could be
-- used as a reflector, or get stuck in a loop with an autoresponder.
create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text,
  raw_ask     text,     -- what they actually wrote, so a human can triage later
  source      text not null default 'inbound_email',
  status      text not null default 'new',
  invited_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint leads_status_check check (status in ('new','invited','joined','ignored'))
);

create index if not exists leads_status_idx on leads(status, created_at desc);

-- ---------------------------------------------------------------------------
-- Durable per-person preferences, stated or inferred.
-- ---------------------------------------------------------------------------
-- `source` + `evidence_message_id` are the point: every inferred preference can
-- be traced back to the sentence that produced it. `active` allows retraction
-- without losing the history of what we once believed.
create table if not exists person_preferences (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references people(id) on delete cascade,
  kind                 text not null,
  value                text not null,
  source               text not null,
  confidence           numeric(3,2) not null default 0.50,
  evidence_message_id  uuid references messages(id) on delete set null,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint person_preferences_kind_check check (kind in (
    'wants','avoids','timing','format','intro_style')),
  constraint person_preferences_source_check check (source in (
    'onboarding_chat','email_reply','decline_reason','manual')),
  constraint person_preferences_confidence_check check (confidence >= 0 and confidence <= 1)
);

create index if not exists person_preferences_person_idx
  on person_preferences(person_id, active);

-- Don't accumulate duplicate copies of the same belief from repeated replies.
create unique index if not exists person_preferences_unique_idx
  on person_preferences(person_id, kind, lower(value));

-- ---------------------------------------------------------------------------
-- RLS: consistent with 0012/0013 — disabled, all access via server-side keys.
-- The same HARDENING note applies, and applies harder here: `leads` holds the
-- addresses of people who are not members and never consented to anything.
-- ---------------------------------------------------------------------------
alter table inbound_events    disable row level security;
alter table leads             disable row level security;
alter table person_preferences disable row level security;
