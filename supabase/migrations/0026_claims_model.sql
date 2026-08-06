-- Nexus v0.2, build step 1 (SPEC.md §2, §9.1): the claims-based entity graph
-- that both the Gmail ingest and the matching engine will read/write, replacing
-- `people`'s plain columns. `people`/`matches` are left untouched by this
-- migration — they keep serving the live matching engine while `entities`/
-- `claims` are populated and validated (backfill script, a later step).
--
-- Single-tenant, internal to Interplay's Workspace (SPEC §3.3, §9.1): one fixed
-- workspace row rather than skipping workspace_id entirely, so multi-tenant is
-- additive later instead of a rewrite.
--
-- RLS is REAL here, with policies, not disabled. This project has already paid
-- for that lesson twice (0012, 0013): 0012 disabled RLS outright to unblock the
-- publishable-key client used by every app/api route, and 0013 found that a
-- table left with RLS *enabled and zero policies* silently drops every insert —
-- the intro-frequency ledger wrote nothing for months and nobody noticed
-- because the failure mode is silence, not an error. `app/lib/db.ts` connects
-- with the publishable key as `anon`, so the policies below are the actual
-- enforcement boundary for every ingest/summarize route added in steps 2-3, not
-- decoration. Do not "fix" a blocked insert here by disabling RLS — add or
-- widen a policy instead.

create extension if not exists vector; -- already enabled via 0001; safe no-op

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- Fixed row + helper so every policy and every insert references the same
-- constant, rather than a magic UUID string copy-pasted across SQL and app code.
insert into workspaces (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Interplay')
on conflict (id) do nothing;

create or replace function current_workspace_id() returns uuid
language sql stable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

create table entities (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace_id() references workspaces(id),
  kind         text not null check (kind in ('person','organization')),
  -- Denormalised for display and search only. Never written by hand — always
  -- projected from claims via projectDisplayName()/summarizeEntity(), so it can
  -- be rebuilt from claims and can never disagree with them.
  display_name text,
  summary      text,
  embedding    vector(1536), -- 1536 = OpenAI text-embedding-3-small, matches src/lib/openai.ts::embed()
  created_at   timestamptz not null default now()
);
create index entities_embedding_hnsw on entities using hnsw (embedding vector_cosine_ops);
create index entities_workspace_idx on entities (workspace_id);

create table claims (
  id            bigserial primary key,
  workspace_id  uuid not null default current_workspace_id() references workspaces(id),
  subject_id    uuid not null references entities(id) on delete cascade,
  attribute     text not null,          -- 'role' | 'thesis' | 'check_size' | 'email' | 'wants' | …
  value         jsonb not null,
  source        text not null,          -- 'gmail:<msg_id>' | 'reply:<thread_id>' | 'form' | 'manual' | 'migration:people.<id>'
  method        text not null check (method in ('self_reported','enriched','inferred','manual')),
  confidence    numeric(3,2) not null check (confidence between 0 and 1),
  observed_at   timestamptz not null,   -- when the fact was true, not when we wrote it
  evidence      text,                   -- the sentence it came from, for the review queue
  superseded_by bigint references claims(id),
  created_at    timestamptz not null default now()
);
create index claims_subject_attr_idx on claims (subject_id, attribute) where superseded_by is null;
create index claims_workspace_attr_idx on claims (workspace_id, attribute, observed_at) where superseded_by is null;

-- Writes are inserts, never updates (enforced in src/lib/claims.ts, the only
-- path in). Two live claims on one (subject_id, attribute) with different
-- values *is* the conflict flag — no separate table.
create view resolved_attributes as
select distinct on (subject_id, attribute)
  subject_id, attribute, value, source, method, confidence, observed_at, evidence,
  count(*) over (partition by subject_id, attribute) > 1 as contested,
  now() - observed_at > interval '90 days' as stale
from claims
where superseded_by is null
order by subject_id, attribute,
  (method = 'self_reported') desc,   -- self-reported wins for subjective fields
  confidence desc,
  observed_at desc;

create table edges (
  id           bigserial primary key,
  workspace_id uuid not null default current_workspace_id() references workspaces(id),
  from_id      uuid not null references entities(id) on delete cascade,
  to_id        uuid not null references entities(id) on delete cascade,
  kind         text not null,      -- knows | invested | served | introduced | invited
  strength     numeric(3,2),
  source       text not null,
  observed_at  timestamptz not null,
  unique (from_id, to_id, kind, source)
);
create index edges_from_idx on edges (from_id);
create index edges_to_idx on edges (to_id);
create index edges_workspace_idx on edges (workspace_id);

-- Entity resolution never hard-merges (two investors named Chen at different
-- funds, and one person changing firms, are both common). A bad merge is
-- invisible until it produces a wrong intro, so candidates always go to review.
create table entity_links (
  id         bigserial primary key,
  left_id    uuid not null references entities(id) on delete cascade,
  right_id   uuid not null references entities(id) on delete cascade,
  confidence numeric(3,2) not null,
  basis      text not null,     -- what matched: 'email' | 'name+org' | 'thread'
  status     text not null default 'candidate' check (status in ('candidate','confirmed','rejected')),
  unique (left_id, right_id)
);

-- === RLS: real policies, scoped to the single workspace, never disabled ===
alter table workspaces    enable row level security;
alter table entities      enable row level security;
alter table claims        enable row level security;
alter table edges         enable row level security;
alter table entity_links  enable row level security;

create policy workspaces_select on workspaces for select to anon, authenticated
  using (id = current_workspace_id());

create policy entities_rw on entities for all to anon, authenticated
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

create policy claims_rw on claims for all to anon, authenticated
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

create policy edges_rw on edges for all to anon, authenticated
  using (workspace_id = current_workspace_id())
  with check (workspace_id = current_workspace_id());

-- entity_links has no workspace_id of its own (SPEC §2.4 doesn't add one);
-- scope through the referenced entity instead so it can't leak across a future
-- second workspace.
create policy entity_links_rw on entity_links for all to anon, authenticated
  using (exists (select 1 from entities e where e.id = left_id and e.workspace_id = current_workspace_id()))
  with check (exists (select 1 from entities e where e.id = left_id and e.workspace_id = current_workspace_id()));
