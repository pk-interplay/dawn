-- The demo cohort: fictional people, real inbox.
--
-- 0016 built a wall between `is_synthetic = true` fixtures and real members, so a
-- colleague could never be offered an intro to someone who doesn't exist. That wall
-- is right for production and exactly wrong for the 3-day pilot, whose entire point
-- is to introduce ~5 real teammates to people the operator plays over email.
--
-- Rather than punch a hole in the cohort check (`fetchCandidates` would then have to
-- reason about three cohorts), demo personas join the REAL cohort — is_synthetic =
-- false, deliverable addresses — and carry a separate marker. Matching therefore
-- needs no change at all: real members and demo personas are one pool, and the
-- seeded @example.com fixtures stay quarantined on the other side of the same wall.
--
-- What the marker buys, given the personas are otherwise indistinguishable from
-- members:
--   * `run-matches` excludes them as SUBJECTS, so Dawn never opens an introduction
--     on a persona's behalf. Without this the pool self-matches: persona↔persona
--     intros, both halves landing in the operator's inbox, drowning the real signal.
--   * Teardown is one predicate instead of a remembered list of ids.
--   * The admin monitor can label them, so a run is never misread as real traction.
alter table people
  add column if not exists is_demo_persona boolean not null default false;

-- `people_cohort_idx` (0016) covers (is_synthetic, paused); the scan in run-matches
-- now also filters on is_demo_persona.
create index if not exists people_demo_cohort_idx
  on people(is_synthetic, is_demo_persona, paused);

-- Find them by address too: the personas share one operator mailbox via plus-address
-- tags (pk+ava@…), which is what inbound triage matches on to work out which persona
-- a reply is speaking for.
create index if not exists people_email_base_idx
  on people(split_part(lower(email), '+', 1))
  where email is not null;
