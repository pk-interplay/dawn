-- Match v0's access model on the new v1 tables.
--
-- v0 runs with RLS disabled on people/matches/intros and all server routes use
-- the publishable key. If RLS is left ON for the v1 tables, inserts from the app
-- fail with: "new row violates row-level security policy for table ...".
-- Disable RLS here so the app can write, consistent with the rest of the schema.
--
-- HARDENING (fast-follow before any public exposure): re-enable RLS with
-- policies, or route trusted server writes through the service-role key instead
-- of the publishable key.
alter table introductions disable row level security;
alter table conversations disable row level security;
alter table messages      disable row level security;
alter table relationships disable row level security;
alter table interactions  disable row level security;
