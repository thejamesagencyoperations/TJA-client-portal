-- ============================================================
-- TJA CLIENT PORTAL — schema v2 (production-readiness pass)
-- Run AFTER schema.sql, in: SQL Editor → New query → paste → Run.
-- Idempotent — safe to re-run.
--
-- Fixes over v1:
--   1. ADMIN RLS — v1 scoped the admin to their own client_id
--      (celtic-elevator), so admin writes for every other client were
--      silently rejected and app_state stayed empty. Admins now read
--      and write ALL clients' rows.
--   2. SIGNUP TRIGGER — v1 defaulted a new user's client_id to
--      'celtic-elevator', which put every unprovisioned user in
--      Celtic's workspace. Now defaults to 'unassigned' (the app
--      denies logins that map to no real workspace).
--   3. profiles — admins can read every profile (needed to manage
--      client logins from the portal later).
-- ============================================================

-- ---- 2. signup trigger: no more celtic default --------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, role, client_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'client'),
    coalesce(new.raw_user_meta_data->>'client_id', 'unassigned')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

-- ---- clean up any rows the old default mis-assigned ----------------
-- (Only rows whose email clearly is NOT a celtic login but got the
--  celtic default. The provisioning script re-points them correctly;
--  this just stops them opening Celtic's workspace in the meantime.)
update public.profiles
   set client_id = 'unassigned'
 where client_id = 'celtic-elevator'
   and email not in ('clientservices@thejamesagency.com',
                     'celticelevator@thejamesagency.com');

-- ---- 3. profiles: self-read (v1) + admin reads all -----------------
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid() or public.my_role() = 'admin');

-- ---- 1. app_state: admin = all clients; client = own rows only -----
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() = 'admin'
    or client_id = public.my_client_id()
  );

drop policy if exists app_state_write on public.app_state;
create policy app_state_write on public.app_state
  for all
  using (
    public.my_role() = 'admin'
    or (client_id = public.my_client_id() and scope in ('files','deliverables'))
  )
  with check (
    public.my_role() = 'admin'
    or (client_id = public.my_client_id() and scope in ('files','deliverables'))
  );

-- ============================================================
-- After this, provision the real client users:
--   node scripts/provision-supabase-users.mjs
-- (needs SUPABASE_SERVICE_ROLE_KEY in the environment — see the
--  script header; NEVER commit that key.)
-- ============================================================
