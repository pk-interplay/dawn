-- Make people contactable and schedulable.
--
-- v0 had no way to actually reach a member — Dawn drafted emails the member
-- sent by hand. For the agent to send opt-in intros and coordinate meetings
-- itself, each person needs an email address, a timezone (for proposing
-- meeting times), and controls for how often Dawn reaches out. `user_id` links
-- a person row to its Supabase auth user, closing the localStorage-only
-- identity gap; it is nullable so synthetic/seeded people and the existing flow
-- never break.
alter table people
  add column if not exists email         text,
  add column if not exists user_id       uuid,      -- references auth.users(id); nullable
  add column if not exists timezone      text,      -- IANA tz, e.g. 'America/New_York'
  add column if not exists paused        boolean not null default false,  -- opt out of new intros
  add column if not exists intro_cadence text not null default 'weekly';  -- daily | weekly | biweekly | monthly

-- Fast lookup by auth user, and by email for inbound-email → person resolution.
create index if not exists people_user_id_idx on people(user_id);
create index if not exists people_email_idx on people(lower(email));
