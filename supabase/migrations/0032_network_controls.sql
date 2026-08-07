-- Network-wide experiment controls.
--
-- Two operator knobs, held in a single row, that govern the whole cohort at once
-- so intro frequency can be A/B'd over time without editing every member:
--
--   enabled    — the master switch. When false, /api/cron/run-matches stops before
--                it opens any introduction (a targeted ?person_id= test run is the
--                one deliberate override — same posture as the cadence bypass there).
--   intensity  — a multiplier on every member's cadence WINDOW. The run-matches gate
--                divides the per-member window by this number, so 2.0 halves the wait
--                (twice as many intros), 0.5 doubles it (half as many). 1.0 is today's
--                behaviour exactly, which is why it is the default.
--
-- A singleton, not a settings-per-key table: there are two fields and one network,
-- and the `id` check keeps it to a single row so readers never have to pick one.

create table if not exists network_settings (
  -- Always true; the check constraint makes a second row impossible, so the whole
  -- table is one addressable row that read/write both target with `.eq("id", true)`.
  id boolean primary key default true,
  enabled boolean not null default true,
  -- Bounded in the DB as a backstop; the admin API clamps to the same range before
  -- writing, and the UI offers a narrower experiment band (0.25×–4×). The floor is
  -- above zero because run-matches divides by this value.
  intensity numeric not null default 1.0,
  updated_at timestamptz not null default now(),
  -- The admin email that last saved, for the audit line in the monitor.
  updated_by text,
  constraint network_settings_singleton check (id),
  constraint network_settings_intensity_range check (intensity >= 0.1 and intensity <= 10)
);

-- Seed the single row with the defaults (== current behaviour: on, 1.0×). Idempotent
-- so re-running the migration is a no-op rather than a duplicate-key error.
insert into network_settings (id) values (true) on conflict (id) do nothing;

-- RLS is left disabled (the default for a table created via SQL), matching the
-- posture of `people`/`matches` (see 0012): the app's publishable-key client reads
-- and writes this row directly, and the only writer is the requireAdmin-gated route.
