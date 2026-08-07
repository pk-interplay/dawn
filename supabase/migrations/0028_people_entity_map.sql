-- Nexus v0.2 build step 3/backfill (SPEC.md §7 step 3, plan §"Data migration").
-- Joins legacy `people` rows to their migrated `entities` row, so the ported
-- matching path can translate `matches.person_a_id`/`person_b_id` (the only
-- calibration signal the project has — SPEC §5.3) into entity ids without
-- migrating `matches` rows into claims, which would misuse the attribute
-- model: a match is a relationship judgment between two entities, not an
-- attribute of one.
--
-- Dropped once `matches` itself is retired (build step 5, out of scope here).
create table people_entity_map (
  person_id uuid primary key references people(id) on delete cascade,
  entity_id uuid not null unique references entities(id) on delete cascade
);

alter table people_entity_map enable row level security;
create policy people_entity_map_rw on people_entity_map for all to anon, authenticated
  using (true) with check (true);
-- No workspace_id to scope by (it joins two single-tenant tables); real
-- policy rather than a disable statement regardless, per the 0012/0013 rule.
