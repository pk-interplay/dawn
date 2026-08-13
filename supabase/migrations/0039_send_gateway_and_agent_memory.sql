-- Send gateway + agent memory.
--
-- Two things land together because they are the two halves of turning the hourly
-- matching cron from a pipeline that stops at a `matches` row into an agent that
-- composes real introductions and remembers what it learned doing so.
--
--   `sends` + `suppressions` — SPEC §3.2's send gateway. One function, every send,
--       no exceptions, ordered suppression → consent → rate limit → idempotency →
--       approval. These are the tables the first four gates read and write.
--
--   `agent_notes` — what the matchmaker knows that isn't a fact about a person.
--
-- Delivery is OFF when this ships (DAWN_DELIVERY_ENABLED, see src/lib/send-gateway.ts),
-- so every row `sends` gets on day one is a `draft`. That is the point: the drafts are
-- reviewable before anything is deliverable, and the gateway is exercised for real in
-- the meantime rather than being code nobody has run.

-- ---------------------------------------------------------------------------
-- suppressions — global opt-out. Gate 1, checked first, hard fail.
-- ---------------------------------------------------------------------------
--
-- Keyed by email rather than person_id on purpose. "Stop emailing me" is a statement
-- about an ADDRESS, and it has to hold for an address that belongs to nobody in
-- `people` yet: a sourced lead, someone who replied from a second address, a person
-- who was deleted and re-added. A person-scoped opt-out silently fails open in every
-- one of those cases, which is precisely when it matters most.
--
-- citext so Ada@Example.com and ada@example.com are the same suppression. Postgres
-- treats them as distinct text; every mail provider does not.
create extension if not exists citext;

create table if not exists suppressions (
  email      citext primary key,
  -- 'unsubscribe' (they replied with the word), 'bounce' (hard bounce), 'complaint'
  -- (spam report), 'manual' (an operator). Kept as free-ish text: a new reason should
  -- not require a migration during an incident.
  reason     text not null default 'unsubscribe',
  -- Whatever explains the row later: the message id it came from, an operator note.
  evidence   text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- sends — the outbound ledger. Gates 3 and 4 read and write it.
-- ---------------------------------------------------------------------------
--
-- The row is written BEFORE the provider call, and the gateway throws if that write
-- fails. This is not defensive coding; it is the fix for a specific incident. While
-- RLS was silently rejecting an insert on the `intros` ledger, the run failed OPEN and
-- re-emailed everyone on every pass (see the comment at intro-flow.ts step 3, and
-- migration 0013). An idempotency ledger that is best-effort is not an idempotency
-- ledger.
create table if not exists sends (
  id                bigserial primary key,
  -- Forward-looking: `introductions` predates the workspace model (0026) and the whole
  -- legacy `people` cohort lives in the single bootstrap workspace. Defaulted rather
  -- than joined so this column is already correct when the entity graph takes over.
  workspace_id      uuid not null default current_workspace_id() references workspaces(id),

  -- Gate 2 (consent). Two legitimate bases, and they are genuinely different:
  --
  --   'introduction'  — outreach. Dawn is contacting someone who did not write to it,
  --                     so an introduction row must authorise it. This is the case the
  --                     `not null` check below makes structural.
  --   'inbound_reply' — a response to a message that person sent US. The consent is
  --                     the inbound message itself; requiring an introduction here
  --                     would mean the only way to answer a stranger who emailed in is
  --                     to route around the gateway, which is exactly the second send
  --                     path this table exists to prevent.
  --
  -- Recording WHICH basis applies is the point. "We were allowed to send this" is not
  -- a fact you want to have to reconstruct from surrounding rows a year later.
  consent_basis     text not null default 'introduction'
                      check (consent_basis in ('introduction', 'inbound_reply')),
  introduction_id   uuid references introductions(id) on delete cascade,

  kind              text not null check (kind in (
                      -- Outreach: the four messages in an introduction's life.
                      'opt_in_a', 'opt_in_b', 'introduction', 'nudge',
                      -- Replies to people who wrote in first.
                      'waitlist_reply', 'out_of_scope_reply'
                    )),
  -- Nudges are the one kind that legitimately repeats (MAX_NUDGES = 2), so the
  -- idempotency key needs a discriminator within the kind. 0 for everything else.
  attempt           smallint not null default 0,

  -- SPEC §3.1: the user's own mailbox for warm intros to people they know, the Nexus
  -- inbox for strangers and anything product-owned. Cold volume never touches a user's
  -- domain reputation, so which identity sent something has to be recorded, not
  -- inferred. 'nexus' | 'user:<uuid>'.
  identity          text not null default 'nexus',

  to_emails         text[] not null default '{}',
  subject           text,
  -- The EXACT string that went out, unsubscribe footer included. Not the draft.
  -- Storing the pre-footer draft makes this a record of an email that was never sent,
  -- and the footer is the one part you most need to be able to prove you included.
  body_sent         text not null,

  status            text not null default 'draft'
                      check (status in ('draft', 'queued', 'sent', 'bounced', 'replied', 'suppressed')),
  -- Populated when status = 'suppressed' or a provider call failed.
  failure_reason    text,

  provider_message_id text,
  thread_id           text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Outreach must name its authorising introduction. This is gate 2: not a check some
-- caller remembers to write, but a row you cannot insert without it.
alter table sends drop constraint if exists sends_consent_check;
alter table sends add constraint sends_consent_check check (
  (consent_basis = 'introduction' and introduction_id is not null)
  or (consent_basis = 'inbound_reply' and introduction_id is null)
);

-- The idempotency key. Insert-before-send plus this constraint is what makes a
-- duplicate send a database error rather than a second email.
--
-- Only covers outreach. Postgres treats NULLs as distinct in a unique index, so
-- inbound replies (introduction_id null) never collide here — deliberately: their
-- de-duplication is the `inbound_events` replay guard and `leads.invited_at`, which
-- answer the question that actually matters there ("have we already written to this
-- person at all"), not "is this the same message twice".
create unique index if not exists sends_idempotency_idx
  on sends (introduction_id, kind, attempt)
  where introduction_id is not null;

-- Gate 3 (rate limit) counts off this index: recent sends per identity, then per
-- recipient domain in code. Partial on the statuses that represent real volume —
-- a draft consumed no reputation and must not count against the limit.
create index if not exists sends_rate_idx
  on sends (identity, created_at desc)
  where status in ('queued', 'sent', 'bounced', 'replied');

-- The review surface: what is sitting in drafts, newest first.
create index if not exists sends_drafts_idx
  on sends (created_at desc)
  where status = 'draft';

-- ---------------------------------------------------------------------------
-- agent_notes — the matchmaker's memory.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT `claims`. A claim is an attribute of a person, drawn from stated or
-- observed evidence, and the matching layer reads it as ground truth; CI enforces that
-- the only writer is claims.ts. What the matchmaker learns is a different kind of thing
-- — "this cohort never replies to cold intros", "these two were introduced by someone
-- else last month" — and it is the agent's own opinion, not a fact about anybody.
-- Writing model heuristics into `claims` would corrupt the vocabulary the ranker
-- depends on, for exactly the reason profile-claims.ts drops `suggestedIntros`:
-- a reason is not a claim.
--
-- The SHAPE mirrors `claims` (0026) on purpose — append-only, provenance, confidence,
-- supersede rather than update — so it reads the same way to anyone who has read that
-- table, and so a note can be retired without losing the record that it was once held.
--
-- Postgres rather than an Anthropic memory store: the matcher queries its own memory
-- as part of candidate selection, joined against `people`. A filesystem-backed store
-- can be read as prose but cannot be joined, which is the whole requirement.
create table if not exists agent_notes (
  id            uuid primary key default gen_random_uuid(),

  -- 'global' — an operating heuristic with no subject ("intros land better midweek").
  -- 'person' — about one member (subject_id set).
  -- 'pair'   — about two specific people together (both subject columns set).
  scope         text not null check (scope in ('global', 'person', 'pair')),
  subject_id    uuid references people(id) on delete cascade,
  subject_b_id  uuid references people(id) on delete cascade,

  note          text not null check (length(btrim(note)) > 0),
  -- 'observation' — something it noticed. 'heuristic' — a rule it derived and intends
  -- to apply. 'correction' — a previously held belief it now thinks was wrong. The
  -- distinction matters when reading these back: a correction should outrank the
  -- heuristic it corrects even at equal confidence.
  kind          text not null default 'observation'
                  check (kind in ('observation', 'heuristic', 'correction')),
  confidence    numeric(3,2) not null default 0.50 check (confidence >= 0 and confidence <= 1),

  -- Which cron run wrote this, so a bad run's notes can be found and retired together.
  run_id        text,

  -- Append-only. Retiring a note sets active = false and points at its replacement,
  -- so the history of what the agent believed survives the belief changing.
  superseded_by uuid references agent_notes(id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Enforce the scope contract rather than trusting the writer: a 'person' note without
-- a subject is unreadable, and a 'global' note WITH one is silently mis-scoped and
-- will never be retrieved by the query that should find it.
alter table agent_notes drop constraint if exists agent_notes_scope_subject_check;
alter table agent_notes add constraint agent_notes_scope_subject_check check (
  (scope = 'global' and subject_id is null and subject_b_id is null)
  or (scope = 'person' and subject_id is not null and subject_b_id is null)
  or (scope = 'pair'   and subject_id is not null and subject_b_id is not null)
);

-- The read path: active notes for a scope, best-supported first.
create index if not exists agent_notes_lookup_idx
  on agent_notes (scope, subject_id, confidence desc)
  where active;

-- Pair lookups come in unordered (is this (a,b) or (b,a)?), so index the reverse too
-- rather than making every caller remember to query both ways.
create index if not exists agent_notes_pair_reverse_idx
  on agent_notes (subject_b_id, subject_id)
  where active and scope = 'pair';

-- RLS left disabled on all three, matching the operational tables in 0012/0013:
-- every writer is a service-role cron route gated by CRON_SECRET (app/lib/authz.ts).
-- This is deliberately unlike the claims graph (0026), which is user-facing and has
-- real policies.
