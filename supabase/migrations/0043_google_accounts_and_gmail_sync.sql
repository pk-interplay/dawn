-- 0043: server-side Google credentials + Gmail sync state.
--
-- Until now the refresh token existed ONLY inside the NextAuth JWT browser
-- cookie — no server-side job could ever act for a user, so the graph was a
-- one-time onboarding snapshot: no re-sync, rotation never persisted, and an
-- inactive user's only credential expired with their 30-day session. These two
-- tables are what make a background Gmail sync possible at all.

-- Server-side Google credentials. RLS enabled with ZERO policies — service-role
-- only, the chat_threads (0034) posture. refresh_token_enc is app-layer
-- AES-256-GCM ("v1:..." — src/lib/google-token-crypto.ts); the key lives in the
-- GOOGLE_TOKEN_ENC_KEY env var, never in this database.
create table if not exists google_accounts (
  google_sub               text primary key,  -- providerAccountId; = entities.auth_user_id
  email                    text not null,
  refresh_token_enc        text,
  -- Short-lived access-token cache so a cron pass and an interactive route in
  -- the same hour share one token (and one quota window) instead of refreshing
  -- twice. Not worth encrypting: minutes-lived and useless without scopes.
  access_token             text,
  access_token_expires_at  timestamptz,
  scopes                   text,
  -- Set on invalid_grant (the user revoked access or the grant is dead).
  -- Cleared on the next sign-in: prompt=consent means every sign-in delivers a
  -- fresh refresh token, so the row self-heals.
  revoked_at               timestamptz,
  -- Transient refresh failures only (5xx/network). Never causes revocation.
  refresh_failure_count    int not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table google_accounts enable row level security;
revoke all on table google_accounts from anon, authenticated;

-- Per-mailbox sync cursor + the claim row that serializes work on one mailbox.
-- The conditional-update claim (status <> 'running' OR started_at stale) is the
-- ingest overlap guard: onboarding ingest and the cron sync both take it, so two
-- concurrent reads can no longer burn double quota and 429 each other.
create table if not exists gmail_sync_state (
  google_sub          text primary key references google_accounts(google_sub) on delete cascade,
  history_id          text,          -- Gmail history baseline (users/me/profile); null until first ingest
  last_synced_at      timestamptz,
  last_full_ingest_at timestamptz,
  status              text not null default 'idle' check (status in ('idle','running','error')),
  started_at          timestamptz,   -- claim time; stale after 15 min → takeover
  failure_count       int not null default 0,
  last_error          text,
  updated_at          timestamptz not null default now()
);
-- The cron's fan-out order: oldest-synced first, never-synced first of all.
create index if not exists gmail_sync_state_due on gmail_sync_state (last_synced_at asc nulls first);
alter table gmail_sync_state enable row level security;
revoke all on table gmail_sync_state from anon, authenticated;

-- Distilled synthesis evidence, captured at ingest time. What makes Regenerate
-- free: synthesizeProfile reads this instead of re-reading six months of Gmail
-- (a full quota-minute) inside a 120s function.
alter table profile_drafts add column if not exists evidence jsonb;

-- Evidence can exist BEFORE a draft does — that is exactly the case that
-- matters (synthesis timed out or failed; the mailbox read succeeded; the user
-- presses Regenerate). readStagedDraft schema-validates draft on read, so a
-- null draft reads as "no draft staged", same as before.
alter table profile_drafts alter column draft drop not null;
