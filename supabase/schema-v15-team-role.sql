-- ============================================================
-- schema-v15 — the 'team' role (general TJA staff, VIEW ONLY)
--
-- Run in: Supabase SQL Editor → New query → paste → Run. Idempotent.
--
-- WHY: every TJA team member should be able to see any client's dashboard, but nobody outside
-- admin / AM-PM / creative needs to change anything (Cameron 2026-07-29). 'team' is therefore
-- a read-only staff tier: it joins the staff READ set and gets NO write policy of any kind.
--
-- This is deliberately the same shape as 'media' (schema-v10) minus the media-request triage:
-- because 'team' appears in NO insert/update/delete policy, a team JWT cannot write app_state
-- even with a hand-crafted request outside the UI. View-only is enforced at the database, not
-- by hiding buttons.
--
-- Also note 'team' owns no client workspace — manage-users assigns the '_team' sentinel, the
-- same idea as '_admin' / '_manager' / '_creative' / '_media', so a team login can never be
-- mistaken for (or land inside) a real client's workspace.
--
-- ROLLBACK (requires no role='team' profiles to remain):
--   alter table public.profiles drop constraint profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role in ('admin','manager','client','creative','media'));
--   -- then re-run the app_state_read policy from schema-v10-media-role.sql
-- ============================================================

-- ---- 1. allow the new role -------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','client','creative','media','team'));

-- ---- 2. READ: 'team' joins the staff read set (reads all clients) ----
-- Unchanged from v10 except 'team' added. Clients still read only their own rows and never
-- the waiting room or presence.
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() in ('admin','manager','creative','media','team')
    or (client_id = public.my_client_id()
        and scope not in ('deliverables_draft','presence'))
  );

-- app_state_insert / app_state_update / app_state_delete are deliberately NOT touched —
-- 'team' appears in none of them, which is the entire point. Do not "fix" this by adding one.

-- ---- 3. Verify (read-only) -------------------------------------------
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.profiles'::regclass and contype = 'c';
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'public.app_state'::regclass order by polname;
