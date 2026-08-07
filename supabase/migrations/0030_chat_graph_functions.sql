-- Nexus v0.2: retrieval functions for the chat surface, plus two fixes.
--
-- The chat has two scopes — "my network" (only contacts the caller synced from
-- their own mailbox) and "everyone's network" (every teammate's contacts, which
-- is what makes a warm-path answer possible). Both functions below take
-- `connector_ids`, which the route always builds server-side from the session:
-- `[viewerEntityId]` for my-network, `null` for everyone's. The model never sees
-- or sets that parameter, so scope is not something a prompt can talk its way
-- past.
--
-- Both are `stable` and deliberately NOT `security definer`, so they execute as
-- the caller and the workspace policies on entities/edges/claims from 0026 still
-- apply. Same posture as match_entities (0027).

create extension if not exists pg_trgm;

-- === Scoped vector search ===
--
-- match_entities (0027) searches every entity in the workspace with no edge
-- awareness. That is correct for the matching cron, whose whole job is ranking
-- strangers, and wrong for "my network", which must not see past the caller's own
-- synced contacts.
--
-- Overfetching from match_entities and post-filtering in TypeScript was the
-- cheaper option and is rejected: it silently loses recall, and the failure it
-- produces — Dawn saying she doesn't know anyone at a company when you do — is
-- precisely the kind of quiet wrongness that makes a graph product untrustworthy.
--
-- Tradeoff, stated: filtering before the ORDER BY means Postgres computes exact
-- cosine distance over the reachable set rather than using entities_embedding_hnsw.
-- At this workspace's size (low thousands of entities from six months of mailbox
-- metadata) exact search is both fast and MORE accurate than ANN, since HNSW is
-- approximate by construction. Revisit past ~100k entities.
create or replace function match_entities_in_network(
  query_embedding vector(1536),
  exclude_id      uuid,
  connector_ids   uuid[] default null,   -- null = any connector in the workspace
  match_count     int    default 10
) returns table (
  id             uuid,
  display_name   text,
  summary        text,
  similarity     float,
  connector_id   uuid,
  connector_name text,
  strength       numeric,
  observed_at    timestamptz
)
language sql stable as $$
  with reachable as (
    -- One row per contact: the strongest, most recent connector is the one worth
    -- naming. `strength desc nulls last` matters — strength is nullable, and a
    -- null must not outrank a real tie.
    select distinct on (e.to_id) e.to_id, e.from_id, e.strength, e.observed_at
    from edges e
    where e.kind = 'knows'
      and e.to_id <> exclude_id
      and (connector_ids is null or e.from_id = any(connector_ids))
    order by e.to_id, e.strength desc nulls last, e.observed_at desc
  )
  select t.id, t.display_name, t.summary,
         1 - (t.embedding <=> query_embedding) as similarity,
         c.id, c.display_name, r.strength, r.observed_at
  from reachable r
  join entities t on t.id = r.to_id
  join entities c on c.id = r.from_id
  where t.embedding is not null
  order by t.embedding <=> query_embedding
  limit match_count;
$$;

-- === Name / email / domain lookup ===
--
-- "Who do I know at Anthropic?" is a domain match on the `email` claim. Semantic
-- similarity against a prose summary misses it, so this is a separate tool rather
-- than a variation of the one above.
--
-- It has to live in SQL for two independent reasons:
--   1. `claims.value` is jsonb, and PostgREST has no `jsonb ilike text` operator —
--      an ilike filter on it errors 42883.
--   2. CI fails the build on any `from("claims")` outside src/lib/claims.ts. That
--      guard exists to funnel WRITES through writeClaim(); reading claims from
--      inside a SQL function is not what it is protecting against, but going
--      through TypeScript would trip it regardless.
--
-- entities.display_name alone is insufficient: projectDisplayName() prefers a
-- `name` claim over the `email` claim, so anyone with a real display name has
-- their address hidden from a display_name-only search.
create or replace function find_entities_by_contact(
  needle        text,
  connector_ids uuid[] default null,
  match_count   int    default 15
) returns table (
  id             uuid,
  display_name   text,
  summary        text,
  matched_on     text,
  connector_id   uuid,
  connector_name text,
  strength       numeric,
  observed_at    timestamptz
)
language sql stable as $$
  with hits as (
    select e.id, 'name'::text as matched_on
    from entities e
    where e.kind = 'person' and e.display_name ilike '%' || needle || '%'
    union
    select c.subject_id, 'email'::text
    from claims c
    where c.superseded_by is null
      and c.attribute = 'email'
      and (c.value #>> '{}') ilike '%' || needle || '%'
  ),
  reachable as (
    select distinct on (e.to_id) e.to_id, e.from_id, e.strength, e.observed_at
    from edges e
    where e.kind = 'knows'
      and (connector_ids is null or e.from_id = any(connector_ids))
    order by e.to_id, e.strength desc nulls last, e.observed_at desc
  )
  select t.id, t.display_name, t.summary, h.matched_on,
         c.id, c.display_name, r.strength, r.observed_at
  from hits h
  join entities t  on t.id = h.id
  -- Inner join, not left: being reachable IS the scope filter. A person nobody in
  -- scope knows is not a result.
  join reachable r on r.to_id = h.id
  join entities c  on c.id = r.from_id
  order by r.strength desc nulls last, r.observed_at desc nulls last
  limit match_count;
$$;

-- Supports the `(value #>> '{}') ilike '%…%'` scan above. Partial, because the
-- only substring search we do is over live email claims.
create index if not exists claims_email_value_trgm_idx
  on claims using gin ((value #>> '{}') gin_trgm_ops)
  where superseded_by is null and attribute = 'email';

-- === Fix: resolved_attributes bypassed RLS ===
--
-- 0026 created this view without security_invoker, so it runs as the view owner
-- and reads `claims` with the owner's rights rather than the caller's — the
-- claims_rw policy never applies to anything read through the view. Harmless
-- while there is exactly one workspace and every policy is scoped to it, and a
-- cross-tenant leak the moment there is a second. Cheaper to fix now than to
-- remember later.
alter view resolved_attributes set (security_invoker = on);
