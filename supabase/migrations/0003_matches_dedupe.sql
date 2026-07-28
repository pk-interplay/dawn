-- Prevent duplicate match rows for the same pair of people, regardless of
-- which one is stored as person_a_id vs person_b_id.
alter table matches
  add column person_low  uuid generated always as (least(person_a_id, person_b_id)) stored,
  add column person_high uuid generated always as (greatest(person_a_id, person_b_id)) stored;

create unique index matches_unique_pair_idx on matches(person_low, person_high);
