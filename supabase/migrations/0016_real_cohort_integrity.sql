-- Make `people` safe for real members.
--
-- Everything here is a prerequisite for letting non-synthetic humans onboard.

-- ---------------------------------------------------------------------------
-- 1. One row per person.
-- ---------------------------------------------------------------------------
-- `people_email_idx` (0007) is a NON-unique index, and /join's only guard against
-- re-onboarding is `loadMember()` — localStorage. So the same person on a second
-- device, or after clearing their browser, silently created a second `people` row.
--
-- The consequence was worse than mere duplication: inbound triage resolves the
-- sender with `.ilike("email", …).maybeSingle()`, which errors when two rows match.
-- The member would resolve to null, be classified `non_member`, and receive the
-- "Dawn is members-only, I've added you to the waitlist" reply — i.e. duplicate
-- signup made a real member invisible to the agent.
--
-- Partial so the seeded rows with null emails remain legal.
create unique index if not exists people_email_unique_idx
  on people(lower(email))
  where email is not null;

-- One member per auth user, for the same reason.
create unique index if not exists people_user_id_unique_idx
  on people(user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Keep seeded fixtures out of real people's introductions.
-- ---------------------------------------------------------------------------
-- The 20 seeded personas are matchable rows with plausible profiles and
-- undeliverable @example.com addresses. `run-matches` scans every unpaused row, so
-- onboarding real colleagues would have produced warm intros to people who do not
-- exist.
--
-- A flag rather than a delete: the seed data is how the pipeline gets exercised
-- between real tests, and deleting it would cascade through matches,
-- introductions, conversations and relationships.
--
-- Matching never crosses this boundary in either direction (see fetchCandidates),
-- which keeps the synthetic sandbox loop working — including the personas pointed
-- at real inboxes for testing — while real members only ever meet real members.
alter table people
  add column if not exists is_synthetic boolean not null default false;

-- Every row that exists today is a seeded fixture; real members onboard via /join,
-- which inserts with the false default.
update people set is_synthetic = true where is_synthetic = false;

create index if not exists people_cohort_idx on people(is_synthetic, paused);
