-- ============================================================
-- TJA CLIENT PORTAL — schema v7: the AM/PM "manager" role
-- Run in: SQL Editor → New query → paste → Run. Idempotent.
-- Run scripts/backup-supabase.mjs first.
--
-- WHY: account managers were going to be role='admin'. The Admin Center
-- was walled off from them in the app, but at the DATABASE level they
-- held exactly the same power as the agency account — RLS grants any
-- 'admin' full read/write on every client, and a JWT works fine outside
-- the UI. That is not a real auth level, it is a hidden button.
--
-- THE TIERS AFTER THIS:
--   admin    → the agency account. Everything, including logins, backup
--              and DELETING data. This is now the "true admin" tier, so
--              the email allowlist that used to fake it is gone.
--   manager  → AM/PM. Full read + write on every client's WORK
--              (dashboard, files, deliverables, drafts, notifications,
--              presence) and on the client registry. CANNOT DELETE
--              anything, and cannot touch profiles (i.e. logins).
--   creative → drafts + notifications only (unchanged).
--   client   → own rows, never drafts/presence (unchanged).
--
-- Managers deliberately keep READ on every client: agencies cover for
-- each other, and the Clients page just defaults to their tagged ones.
--
-- ROLLBACK (back to v6):
--   alter table public.profiles drop constraint profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role in ('admin','client','creative'));
--   drop policy if exists app_state_insert on public.app_state;
--   drop policy if exists app_state_update on public.app_state;
--   drop policy if exists app_state_delete on public.app_state;
--   create policy app_state_write on public.app_state for all
--     using (
--       public.my_role() = 'admin'
--       or (public.my_role() = 'creative' and scope in ('deliverables_draft','notifications'))
--       or (public.my_role() = 'client' and client_id = public.my_client_id()
--           and scope in ('files','deliverables','notifications')))
--     with check ( /* same */ );
--   drop policy if exists app_state_read on public.app_state;
--   create policy app_state_read on public.app_state for select using (
--     public.my_role() in ('admin','creative')
--     or (client_id = public.my_client_id()
--         and scope not in ('deliverables_draft','presence')));
--   (Rollback requires no role='manager' profiles to remain.)
-- ============================================================

-- ---- 1. profiles: allow 'manager' -----------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
  execute $q$alter table public.profiles add constraint profiles_role_check
    check (role in ('admin','manager','client','creative'))$q$;
end $$;

-- ---- 2. READ ---------------------------------------------------------
-- Staff read everything. A client reads only their own rows, and NEVER the
-- waiting room or presence — that line is the draft-invisibility guarantee.
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() in ('admin','manager','creative')
    or (client_id = public.my_client_id()
        and scope not in ('deliverables_draft','presence'))
  );

-- ---- 3. WRITE ---------------------------------------------------------
-- v6 had ONE `for all` policy, which silently also covered DELETE. Managers
-- must be able to write everything but delete nothing, so INSERT/UPDATE and
-- DELETE are now separate policies. Splitting them is the whole point of v7.
drop policy if exists app_state_write on public.app_state;   -- the old for-all
drop policy if exists app_state_insert on public.app_state;
drop policy if exists app_state_update on public.app_state;
drop policy if exists app_state_delete on public.app_state;

create policy app_state_insert on public.app_state
  for insert with check (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  );

create policy app_state_update on public.app_state
  for update using (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  ) with check (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  );

-- DELETE: the agency account ONLY. This is what stops an AM/PM (or anything
-- holding their token) from wiping a client's workspace — SUPA.removeClient
-- is a bulk delete of every scope row for a client.
create policy app_state_delete on public.app_state
  for delete using (public.my_role() = 'admin');

-- (profiles still has NO write policy of any kind — deliberate. It decides
--  everyone's access, so only the manage-users Edge Function may write it,
--  using the service role. Do not "fix" this by adding an admin policy.)

-- ---- 4. Verify (read-only) -------------------------------------------
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.profiles'::regclass and contype = 'c';
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'public.app_state'::regclass order by polname;
