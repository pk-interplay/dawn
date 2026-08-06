-- Nexus v0.2 build step 3 (SPEC.md §5 row 2). Vector search over the new
-- single-column `entities.embedding`, replacing the two directional RPCs
-- (`match_people_by_offering`/`match_people_by_looking_for`) that read
-- `people.embedding_offering`/`embedding_looking_for`.
--
-- Open question (flagged in the plan, not resolved here): this collapses to
-- one embedding per entity, so candidate retrieval loses the directional
-- a_offers_b_wants / b_offers_a_wants split at the vector-search stage —
-- rerank.ts's prompt still sees the offering/wants text and can reason about
-- direction, but recall at this stage changes. Needs explicit sign-off before
-- this is treated as the permanent retrieval shape rather than a step-3
-- placeholder.
create or replace function match_entities(
  query_embedding vector(1536),
  exclude_id uuid,
  match_count int default 10
) returns table (id uuid, display_name text, summary text, similarity float)
language sql stable as $$
  select id, display_name, summary, 1 - (embedding <=> query_embedding) as similarity
  from entities
  where id <> exclude_id and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
