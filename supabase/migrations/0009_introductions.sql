-- The double opt-in workflow instance.
--
-- A `matches` row is just a *suggestion*. An `introduction` is the process of
-- actually connecting two people: Dawn emails one (or both), each opts in or
-- out, and once both are in Dawn coordinates a time. The `state` column tracks
-- exactly where each intro is. (For testing we exercise it single-sided — see
-- the INTRO_TEST_SINGLE_SIDED env flag — but the both-sided path is modeled
-- here so nothing needs reshaping to go live.)
create table if not exists introductions (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid references matches(id) on delete set null,
  person_a_id  uuid not null references people(id) on delete cascade,   -- the person Dawn is helping
  person_b_id  uuid not null references people(id) on delete cascade,   -- the person being suggested
  state        text not null default 'proposed',
  a_response   text not null default 'pending',  -- pending | yes | no
  b_response   text not null default 'pending',  -- pending | yes | no
  rationale    text,
  channel      text not null default 'email',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint introductions_no_self check (person_a_id <> person_b_id),
  constraint introductions_state_check check (state in (
    'proposed','a_invited','b_invited','a_opted_in','b_opted_in',
    'both_opted_in','scheduling','scheduled','completed','declined','expired')),
  constraint introductions_a_resp_check check (a_response in ('pending','yes','no')),
  constraint introductions_b_resp_check check (b_response in ('pending','yes','no'))
);

create index if not exists introductions_person_a_idx on introductions(person_a_id);
create index if not exists introductions_person_b_idx on introductions(person_b_id);
create index if not exists introductions_state_idx on introductions(state);
create index if not exists introductions_created_idx on introductions(created_at desc);

-- RLS intentionally left disabled for this prototype, consistent with the rest.
