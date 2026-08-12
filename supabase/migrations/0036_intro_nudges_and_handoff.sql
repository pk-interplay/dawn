-- Give introductions a clock, and a terminal state for the warm-intro handoff.
--
-- Two changes, both required by the same product decision: Dawn sends double
-- opt-in asks, and once both sides say yes it introduces them and gets out of the
-- way. Previously the happy path ended at `scheduled` — Dawn proposed times and
-- owned the calendar for every intro — and silence had exactly one consequence:
-- expire-intros flipped the row to `expired` after seven days with no follow-up.
-- Since most people do not answer a first email, "wait a week, give up silently"
-- was the most-travelled path through the product.
--
--   next_action_at — when the nudge sweep should next look at this row. This is the
--                    missing piece: `state` said WHAT we were waiting for and
--                    `updated_at` said how long it had been, but nothing said when
--                    to act, so a cron had nothing to select on except "old".
--   awaiting       — which side owes us a reply ('a' | 'b'), so the sweep knows who
--                    to nudge without re-deriving it from the state name.
--   a_nudges /     — per-side counters. Per-side and not one shared count because
--   b_nudges         each side is asked independently: A going quiet and later B
--                    going quiet are two separate follow-up sequences, and a single
--                    counter would let A's silence consume B's allowance.
--   introduced     — the new terminal happy state. `scheduling`/`scheduled` are kept
--                    in the constraint, not removed: rows may already be sitting in
--                    them, and dropping the values would make those rows unwritable.

alter table introductions
  add column if not exists next_action_at timestamptz,
  add column if not exists awaiting       text,
  add column if not exists a_nudges       integer not null default 0,
  add column if not exists b_nudges       integer not null default 0;

-- Added separately from the columns so re-running the migration doesn't fail on an
-- already-present constraint (there is no `add constraint if not exists`).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'introductions_awaiting_check') then
    alter table introductions
      add constraint introductions_awaiting_check check (awaiting in ('a','b'));
  end if;
end $$;

-- Replace the state check to admit `introduced`. Every prior value is carried
-- forward verbatim.
alter table introductions drop constraint if exists introductions_state_check;
alter table introductions
  add constraint introductions_state_check check (state in (
    'proposed','a_invited','b_invited','a_opted_in','b_opted_in',
    'both_opted_in','introduced','scheduling','scheduled','completed','declined','expired'));

-- The nudge sweep's only query: rows waiting on somebody, due now. Partial so the
-- index stays small — the vast majority of rows are terminal and have no due time.
create index if not exists introductions_next_action_idx
  on introductions(next_action_at)
  where next_action_at is not null;

-- Backfill: any row currently waiting on a reply gets a due time derived from when
-- it was last touched, so intros opened before this migration enter the nudge
-- sequence instead of sitting until expire-intros sweeps them. Nudge counts stay 0 —
-- these rows have genuinely never been followed up.
update introductions
   set next_action_at = updated_at + interval '3 days',
       awaiting = case when state in ('a_invited','proposed') then 'a' else 'b' end
 where state in ('proposed','a_invited','b_invited')
   and next_action_at is null;
