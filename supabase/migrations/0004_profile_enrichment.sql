-- Structured profile facets, to give the reranker sharper material to reason
-- over than freeform bio/offering/looking_for prose alone.
alter table people
  add column industry            text,
  add column career_stage        text,
  add column location            text,
  add column meeting_format      text,          -- 'async' | 'call' | 'in_person'
  add column ask_must_haves      text[] default '{}',
  add column ask_nice_to_haves   text[] default '{}',
  add column embedding_tags      vector(1536);

create index people_embedding_tags_hnsw
  on people using hnsw (embedding_tags vector_cosine_ops);

-- Blend in tag-embedding similarity (industry/career_stage/tags/location) when
-- a tags embedding is supplied; defaults preserve prior behavior for callers
-- that don't pass one.
create or replace function match_people_by_offering(
  query_embedding vector(1536),
  exclude_id uuid,
  match_count int default 10,
  query_tags_embedding vector(1536) default null,
  tag_weight float default 0.3
)
returns table (
  id uuid,
  name text,
  headline text,
  offering text,
  looking_for text,
  tags text[],
  similarity float
)
language sql stable
as $$
  select
    id, name, headline, offering, looking_for, tags,
    case
      when query_tags_embedding is null or embedding_tags is null
        then 1 - (embedding_offering <=> query_embedding)
      else (1 - tag_weight) * (1 - (embedding_offering <=> query_embedding))
        + tag_weight * (1 - (embedding_tags <=> query_tags_embedding))
    end as similarity
  from people
  where id <> exclude_id
  order by similarity desc
  limit match_count;
$$;

create or replace function match_people_by_looking_for(
  query_embedding vector(1536),
  exclude_id uuid,
  match_count int default 10,
  query_tags_embedding vector(1536) default null,
  tag_weight float default 0.3
)
returns table (
  id uuid,
  name text,
  headline text,
  offering text,
  looking_for text,
  tags text[],
  similarity float
)
language sql stable
as $$
  select
    id, name, headline, offering, looking_for, tags,
    case
      when query_tags_embedding is null or embedding_tags is null
        then 1 - (embedding_looking_for <=> query_embedding)
      else (1 - tag_weight) * (1 - (embedding_looking_for <=> query_embedding))
        + tag_weight * (1 - (embedding_tags <=> query_tags_embedding))
    end as similarity
  from people
  where id <> exclude_id
  order by similarity desc
  limit match_count;
$$;
