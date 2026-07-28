-- RPC helpers for the matching agent: nearest neighbors by cosine similarity,
-- excluding the querying person, ordered by the corresponding embedding column.

create or replace function match_people_by_offering(
  query_embedding vector(1536),
  exclude_id uuid,
  match_count int default 10
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
    1 - (embedding_offering <=> query_embedding) as similarity
  from people
  where id <> exclude_id
  order by embedding_offering <=> query_embedding
  limit match_count;
$$;

create or replace function match_people_by_looking_for(
  query_embedding vector(1536),
  exclude_id uuid,
  match_count int default 10
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
    1 - (embedding_looking_for <=> query_embedding) as similarity
  from people
  where id <> exclude_id
  order by embedding_looking_for <=> query_embedding
  limit match_count;
$$;
