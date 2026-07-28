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
