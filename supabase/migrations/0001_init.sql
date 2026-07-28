-- Enable pgvector
create extension if not exists vector;

-- People / profiles
create table people (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  headline               text,                -- one-line role/positioning, e.g. "Seed-stage climate tech founder"
  bio                    text,                 -- 2-4 sentence background
  offering               text,                 -- what they can give: expertise, intros, capital, time, etc.
  looking_for            text,                 -- their stated intent/ask
  tags                   text[] default '{}',  -- skills/interests/industry keywords, for filtering & prompt context
  embedding_offering      vector(1536),
  embedding_looking_for   vector(1536),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index people_embedding_offering_hnsw
  on people using hnsw (embedding_offering vector_cosine_ops);

create index people_embedding_looking_for_hnsw
  on people using hnsw (embedding_looking_for vector_cosine_ops);

create index people_tags_gin on people using gin (tags);

-- Agent output: suggested introductions
create table matches (
  id             uuid primary key default gen_random_uuid(),
  person_a_id    uuid not null references people(id) on delete cascade,
  person_b_id    uuid not null references people(id) on delete cascade,
  score          numeric(4,3),         -- 0.000-1.000, LLM-assigned match quality
  rationale      text not null,        -- natural-language "why introduce these two"
  direction      text not null,        -- 'a_offers_b_wants' | 'b_offers_a_wants' | 'mutual'
  status         text not null default 'suggested',  -- suggested | accepted | rejected
  created_at     timestamptz not null default now(),
  constraint matches_no_self check (person_a_id <> person_b_id),
  constraint matches_status_check check (status in ('suggested','accepted','rejected')),
  constraint matches_direction_check check (direction in ('a_offers_b_wants','b_offers_a_wants','mutual'))
);

create index matches_person_a_idx on matches(person_a_id);
create index matches_person_b_idx on matches(person_b_id);
create index matches_status_idx on matches(status);

-- RLS intentionally left disabled for this prototype.
-- All access happens through the Supabase service-role key from trusted
-- server-side scripts. Enable RLS + policies before any public/browser exposure.
