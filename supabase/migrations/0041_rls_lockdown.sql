-- 0041: make the publishable (anon) key inert.
--
-- Until now the anon key was full read/write on effectively the whole database:
-- RLS was disabled outright on most tables (0012/0013/0014, plus tables that never
-- enabled it), and the tables that DID have policies (0026/0028/0029) scoped them
-- to current_workspace_id() — a function that returns a constant, so every policy
-- evaluated to `true` for anon. Publishable keys are designed to be public; this
-- one guarded every contact, claim, and email body in the workspace.
--
-- The fix is 0034's chat_threads pattern applied to the whole schema: RLS enabled
-- with ZERO policies (deny-by-default), plus revoked grants as belt and braces.
-- Real per-user policies are the wrong tool here — they would need a Supabase-Auth
-- JWT this app no longer issues (sessions are NextAuth). The enforcement boundary
-- is the Next.js route gates (requireUser / requireAdmin / isAuthorized /
-- isInboundAuthorized); every server path reaches the DB through the service-role
-- client, which bypasses RLS.
--
-- ORDER MATTERS AT DEPLOY TIME: the app deploy that repoints app/lib/db.ts to the
-- service-role key must be live BEFORE this migration is applied. Applied first,
-- this reproduces 0013's silent-denial incident on every table at once.

-- 1. Enable RLS everywhere it was disabled (0012, 0013, 0014) or never enabled.
alter table people             enable row level security;
alter table matches            enable row level security;
alter table intros             enable row level security;
alter table introductions      enable row level security;
alter table conversations      enable row level security;
alter table messages           enable row level security;
alter table relationships      enable row level security;
alter table interactions       enable row level security;
alter table inbound_events     enable row level security;
alter table leads              enable row level security;
alter table person_preferences enable row level security;
alter table network_settings   enable row level security;
alter table asks               enable row level security;
alter table sends              enable row level security;
alter table suppressions       enable row level security;
alter table agent_notes        enable row level security;

-- 2. Drop the anon-permissive policies. current_workspace_id() returns a constant,
--    so each of these was `using (true)` in costume — 0026's stated intent (a real
--    boundary for the publishable key) was never achieved. The function itself
--    stays: it is the default on workspace_id columns.
drop policy if exists workspaces_select    on workspaces;
drop policy if exists entities_rw          on entities;
drop policy if exists claims_rw            on claims;
drop policy if exists edges_rw             on edges;
drop policy if exists entity_links_rw      on entity_links;
drop policy if exists people_entity_map_rw on people_entity_map;
drop policy if exists profile_drafts_rw    on profile_drafts;

-- 3. Belt and braces. RLS already empties every table read for anon, but the
--    match_* / graph RPCs are plain `stable` functions (not SECURITY DEFINER —
--    0030 is explicit about that), and revoking EXECUTE turns a plausible empty
--    result into a loud error. Default privileges only bind objects created by
--    the role running this migration, which is how the CLI applies them — fine.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke usage on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
