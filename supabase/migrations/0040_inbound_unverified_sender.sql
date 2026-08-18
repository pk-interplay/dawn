-- 0040: admit 'unverified_sender' into the inbound_events decision CHECK.
--
-- triage.ts has emitted decision 'unverified_sender' since the SPF/DKIM handling
-- landed, but 0014's CHECK predates it and no migration widened the list. Every
-- unauthenticated-sender event therefore failed its insert with 23514 — meaning
-- the one class of inbound mail shaped like a spoof attempt was exactly the class
-- with no audit row, no replay guard, and no rate-limit counter. The route's own
-- stated invariant ("EVERY inbound message produces exactly one inbound_events
-- row") was broken for that case.

alter table inbound_events drop constraint inbound_events_decision_check;
alter table inbound_events add constraint inbound_events_decision_check check (decision in (
  'reply_to_intro',     -- a member replying inside a live introduction
  'preference_update',  -- a member telling us something durable about their preferences
  'pause',              -- a member asking us to stop
  'out_of_scope',       -- a member asking for something Dawn doesn't do
  'non_member',         -- sender isn't in `people`
  'rate_limited',       -- sender exceeded their window
  'duplicate',          -- webhook replay of a message we already processed
  'self_send',          -- our own inbox; loop guard
  'unverified_sender'   -- unauthenticated mail claiming a member address, no thread behind it
));
