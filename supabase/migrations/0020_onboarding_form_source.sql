-- Onboarding is a form now, not a chat.
--
-- 0014 constrained `person_preferences.source` to one of four provenances, and
-- the only onboarding-shaped value was 'onboarding_chat'. Onboarding no longer
-- has a chat: it's a LinkedIn upload followed by a single form of multi-select
-- questions. Writing those answers as 'onboarding_chat' would put a lie in the
-- one column whose entire purpose is telling us where a belief came from — and
-- provenance we can't trust can't be used to revoke a bad inference.
--
-- Add the value rather than rename it: the existing rows were genuinely produced
-- by the chat flow, and rewriting their history to say otherwise would be the
-- same defect in the other direction.
alter table person_preferences
  drop constraint if exists person_preferences_source_check;

alter table person_preferences
  add constraint person_preferences_source_check check (source in (
    'onboarding_chat',   -- the retired /join chat; kept for rows it produced
    'onboarding_form',   -- the multi-select questions shown after profile build
    'email_reply',
    'decline_reason',
    'manual'));
