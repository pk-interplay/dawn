-- Nexus v0.2: the entity↔user link, and staging for AI-drafted profiles.
--
-- Until now nothing in the claims model marked "this entity is a signed-in
-- user". `entities` only distinguishes person from organization, and the legacy
-- link (`people.user_id`) belongs to the schema the claims model replaces.
-- `people_entity_map` (0028) is a translation bridge for legacy calibration, not
-- an identity. So the Gmail onboarding flow, the chat surface, and the admin
-- users list each had no way to answer "which entity is me" — this migration
-- gives them one.
--
-- Identity is a STRUCTURAL column on `entities`, not a claim, for the same
-- reason `display_name`/`summary`/`embedding` are: it is machinery, not an
-- assertion about the person. Nobody "claims" which Google account they are with
-- a confidence and an observed_at, and a claim cannot carry a uniqueness
-- constraint — which is the one guarantee that actually matters here, because two
-- entities sharing an auth id is the bug that silently splits someone's graph.
--
-- RLS: `entities` already has entities_rw from 0026 and it covers the new
-- columns, so nothing to widen there. `profile_drafts` gets its own real policy
-- below. Per 0026's header — and the 0012/0013 lesson — a blocked insert here is
-- fixed by widening a policy, never by disabling RLS.

-- The Google `sub`, i.e. session.user.id. Text, not uuid: that is what Google
-- issues, and src/auth.ts pins token.sub = account.providerAccountId precisely so
-- this value is stable across sign-ins (Auth.js otherwise assigns a fresh random
-- id on every sign-in when there is no database adapter, orphaning synced data).
alter table entities add column auth_user_id text;

-- Partial unique index rather than a plain `unique` constraint: the overwhelming
-- majority of entities are contacts with no auth id at all, and a nullable
-- unique column would index every one of those nulls for nothing.
create unique index entities_auth_user_id_key on entities (auth_user_id)
  where auth_user_id is not null;

-- Marks onboarding complete, and is the short-circuit app/onboarding/page.tsx
-- reads to send a returning user straight to the chat.
--
-- Deliberately not inferred from "has a headline claim": a user can regenerate a
-- draft, and a claim can be superseded, so claim presence answers "do we know
-- something about them" rather than "have they finished onboarding". Those come
-- apart the first time someone regenerates, and conflating them would put a
-- returning user back through the ingest screen.
alter table entities add column onboarded_at timestamptz;

-- Draft profile staging, between synthesis and Confirm.
--
-- Deliberately NOT claims. Nothing here has been asserted by anyone yet — the
-- model proposed it and the user has not looked at it. Writing it as claims
-- would make it network-visible through `resolved_attributes` the moment it was
-- generated, which is exactly what the Confirm step exists to prevent, and it
-- would leave rows to retract if the user regenerates or abandons the flow.
-- On Confirm the draft is written through src/lib/claims.ts and this row is
-- dropped, so the table holds only in-flight drafts.
--
-- jsonb rather than columns because the synthesis schema is expected to grow
-- (nexus's equivalent made the same call for the same reason) and a draft that
-- is never read by SQL has nothing to gain from being shredded into columns.
create table profile_drafts (
  entity_id  uuid primary key references entities(id) on delete cascade,
  draft      jsonb not null,
  model      text not null,          -- which model produced it, for eval + debugging
  created_at timestamptz not null default now()
);

alter table profile_drafts enable row level security;

-- No workspace_id of its own — scope through the referenced entity, the same
-- shape as entity_links_rw in 0026, so a future second workspace cannot read
-- another's in-flight drafts.
create policy profile_drafts_rw on profile_drafts for all to anon, authenticated
  using (exists (select 1 from entities e
                 where e.id = profile_drafts.entity_id
                   and e.workspace_id = current_workspace_id()))
  with check (exists (select 1 from entities e
                      where e.id = profile_drafts.entity_id
                        and e.workspace_id = current_workspace_id()));
