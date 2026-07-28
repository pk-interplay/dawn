-- Make the person_preferences dedupe index usable as an upsert conflict target.
--
-- 0014 created the uniqueness guard as `(person_id, kind, lower(value))`. That is
-- valid Postgres and does dedupe case-insensitively, but PostgREST's `onConflict`
-- parameter (what supabase-js `.upsert({ onConflict })` sends) only accepts a list
-- of column NAMES — it cannot name an expression index. Upserting preferences
-- would therefore fail at the API layer rather than dedupe.
--
-- Swap to a plain-column index. The tradeoff is that "Not raising until Q3" and
-- "not raising until q3" can now both exist; that is preferred over lowercasing
-- stored values, since these strings get rendered straight into the matching
-- prompt and should read the way the member wrote them.
drop index if exists person_preferences_unique_idx;

create unique index if not exists person_preferences_unique_idx
  on person_preferences(person_id, kind, value);
