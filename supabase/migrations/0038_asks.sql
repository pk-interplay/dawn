-- Asks: what a person says they want, in their own words.
--
-- SPEC §10 is why this is a table and not a claim. `suggestedIntros` on a profile
-- draft is the model guessing at what someone might like, and profile-claims.ts
-- deliberately drops it on the floor: "a reason is not a claim", and writing model
-- speculation into the controlled vocabulary the matching layer reads as ground truth
-- would corrupt it.
--
-- What changes here is authorship, not the rule. Onboarding now seeds a text box with
-- those suggestions and lets the person edit them before confirming. What comes back
-- is a statement they wrote, which is exactly the `asks`-shaped thing SPEC §10 said
-- belongs in its own table at build step 5. It stays out of `claims` because an ask is
-- a want, not an attribute — it expires, it is acted on, and it is not a fact about
-- who someone is.
--
-- Free text on purpose. An ask is a sentence ("intros to seed-stage fintech founders"),
-- and forcing it into a vocabulary now would be guessing at a taxonomy before there is
-- any evidence for one.

create table if not exists asks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace_id() references workspaces(id),
  entity_id    uuid not null references entities(id) on delete cascade,
  body         text not null check (length(btrim(body)) > 0),
  -- Where the text came from. 'onboarding' is the confirm screen; later sources
  -- (chat, a profile edit) get their own label so provenance stays legible.
  source       text not null default 'onboarding',
  -- Whether the person typed/kept this, versus it being a model suggestion they never
  -- touched. Only user-authored asks should ever drive an intro.
  authored     boolean not null default true,
  -- Soft-close rather than delete: an ask that has been met is history worth keeping.
  fulfilled_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists asks_entity_idx on asks (entity_id) where fulfilled_at is null;
create index if not exists asks_workspace_idx on asks (workspace_id, created_at desc);

-- RLS left disabled, matching `claims`/`entities`/`network_settings` (see 0012):
-- every writer is a service-role route gated by the NextAuth session.
