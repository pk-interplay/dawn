-- ---------------------------------------------------------------------------
-- Sourcing: turn an unserved ask into a shortlist of people to invite.
-- ---------------------------------------------------------------------------
-- The founders' supply-side tool. An unserved ask ("I'm looking for a fractional
-- CFO who's been through a Series A") is demand signal with no matching supply in
-- the network yet, so the fix is not a better match — it is recruiting someone who
-- fits and inviting them in. This migration gives that flow somewhere to put its
-- output.
--
-- Deliberately NOT a new table. `leads` (0014) already models exactly this
-- lifecycle — email, name, raw_ask, source, status new|invited|joined|ignored,
-- invited_at — because inbound non-members needed the same triage. A parallel
-- `sourced_candidates` table would duplicate it and split "people we might invite"
-- across two places, which is the state that makes "did we already contact them?"
-- unanswerable. So this extends `leads` instead.
--
-- The HARDENING note on `leads` applies with full force to every row this flow
-- writes: these are addresses of people who are not members and who consented to
-- nothing. Nothing here sends mail. src/lib/agentmail.ts is a typed no-op and CI
-- fails the build on any email SDK import, so a sourced candidate can only ever
-- leave this system as a draft a human reviewed and sent themselves.

-- 1. Email becomes optional. ------------------------------------------------
-- Exa and Apollo both routinely return a strong candidate — right person, right
-- company, right background — with no deliverable address. Under the original
-- `not null` that candidate cannot be stored at all, so the shortlist would
-- silently drop its best rows and the operator would never know what was missing.
-- Enrichment resolves the address later, as a second step.
alter table leads alter column email drop not null;

-- The uniqueness that replaces it is partial: still exactly one row per known
-- address (so re-sourcing someone already invited updates rather than duplicates),
-- but many rows may sit with email null. A plain unique constraint treats NULLs as
-- distinct in Postgres and so would technically permit this, but the partial index
-- states the intent and keeps the null rows out of the index entirely.
alter table leads drop constraint if exists leads_email_key;
create unique index if not exists leads_email_unique_idx
  on leads (lower(email)) where email is not null;

-- 2. Provenance: which ask motivated sourcing this person. -----------------
-- Without this link the tool cannot answer the only question that matters about
-- it — did recruiting against an unserved ask actually serve that ask? The FK is
-- to `entities`, not `people`: asks are read from the claims graph
-- (resolved_attributes), so the asker is an entity id.
--
-- `on delete set null` rather than cascade: if the asking entity is merged away or
-- removed, the candidate is still a real person we may have already contacted, and
-- deleting that record would lose the fact that we did.
alter table leads
  add column if not exists sourced_for_entity_id uuid references entities(id) on delete set null,
  -- The ask text as it read AT SOURCING TIME. `looking_for` is a mutable profile
  -- field that gets overwritten, so without a copy here a shortlist becomes
  -- unreadable the moment the member edits their profile — the candidates would
  -- appear to have been sourced against a need nobody expressed.
  add column if not exists sourced_for_ask text,
  add column if not exists title             text,
  add column if not exists company           text,
  add column if not exists profile_url       text,
  add column if not exists location          text,
  -- 'exa' | 'apollo' | 'manual'. Kept loose rather than a check constraint: which
  -- providers exist is an integration detail that should not need a migration.
  add column if not exists provider          text,
  -- Why the model thought this person fits the ask, in one or two sentences, for
  -- the operator to agree or disagree with. The shortlist is a review queue, not
  -- an answer.
  add column if not exists rationale         text,
  -- Raw provider payload + citations. Same posture as `claims.evidence`: a
  -- suggestion you cannot trace back to a source is not reviewable.
  add column if not exists evidence          jsonb;

-- 3. 'sourced' as a distinct status. ---------------------------------------
-- Reusing 'new' would conflate two populations with opposite provenance: someone
-- who emailed us unprompted (warm, self-selected, expecting a reply) and someone
-- an API suggested who has never heard of us. They deserve different treatment and
-- different copy, so they get different states.
alter table leads drop constraint if exists leads_status_check;
alter table leads add constraint leads_status_check
  check (status in ('sourced','new','invited','joined','ignored'));

-- Supports the shortlist read: candidates for one ask, newest first.
create index if not exists leads_sourced_for_idx
  on leads (sourced_for_entity_id, created_at desc)
  where sourced_for_entity_id is not null;

comment on column leads.sourced_for_entity_id is
  'The entity whose unserved ask motivated sourcing this candidate. Null for inbound leads.';
comment on column leads.sourced_for_ask is
  'Snapshot of the ask text at sourcing time; looking_for is mutable and would otherwise drift.';
