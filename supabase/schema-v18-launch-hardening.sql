-- ============================================================
-- schema-v18 — LAUNCH HARDENING (2026-11-16, launch audit)
--
-- 1. SIGN-UP CAN NEVER PICK ITS OWN ROLE.
--    handle_new_user copied role + client_id straight out of raw_user_meta_data, which the
--    person signing up controls — so with public sign-ups on, anyone could
--    supabase.auth.signUp({..., options:{data:{role:'admin'}}}) and get an admin profile.
--    Every new auth user now starts as an unassigned client; the manage-users edge function
--    (service role) sets the real role/workspace when it creates or invites a login.
--    (Public sign-ups are also switched OFF in Supabase Auth settings.)
--
-- 2. CLIENTS NO LONGER READ THE RAW DASHBOARD ROW.
--    RLS is row-level, so a client reading its dashboard row got every staff-only field the UI
--    merely hides (CRF $, internal plan items/dependencies, team-only tiles, archived
--    projects). Clients now read it through the client-dashboard edge function, which strips
--    those parts. Staff read access is unchanged.
--    DEPLOY ORDER: client-dashboard function + the v4.15 front end FIRST, then this file.
-- ============================================================

-- ---- 1. signup trigger: role/workspace are never taken from user metadata ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role, client_id)
  values (new.id, new.email, 'client', 'unassigned')
  on conflict (id) do nothing;
  return new;
end; $$;

-- ---- 2. READ: clients lose direct SELECT on their dashboard row ----
-- Unchanged from v15 except 'dashboard' joins the scopes a client can't read directly.
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() in ('admin','manager','creative','media','team')
    or (client_id = public.my_client_id()
        and scope not in ('deliverables_draft','presence','dashboard'))
  );
