-- ============================================================
-- TJA CLIENT PORTAL — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent).
-- ============================================================

-- ---- per-client app state (3 scopes mirror the 3 localStorage keys) ----
create table if not exists public.app_state (
  client_id  text not null,
  scope      text not null check (scope in ('dashboard','files','deliverables')),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (client_id, scope)
);

-- ---- user profiles: maps an auth user to a role + the client they belong to ----
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'client' check (role in ('admin','client')),
  client_id  text not null,
  created_at timestamptz not null default now()
);

-- ---- auto-create a profile on signup (role + client_id come from user metadata) ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, role, client_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'client'),
    coalesce(new.raw_user_meta_data->>'client_id', 'celtic-elevator')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- helpers for RLS ----
create or replace function public.my_client_id() returns text language sql stable as $$
  select client_id from public.profiles where id = auth.uid()
$$;
create or replace function public.my_role() returns text language sql stable as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---- Row Level Security ----
alter table public.profiles  enable row level security;
alter table public.app_state enable row level security;

-- profiles: a user can read their own profile
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid());

-- app_state READ: any signed-in user can read their own client's data
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (client_id = public.my_client_id());

-- app_state WRITE: admins write anything for their client; clients may write
-- only 'files' and 'deliverables' (uploads + creative review), never 'dashboard'
drop policy if exists app_state_write on public.app_state;
create policy app_state_write on public.app_state
  for all
  using (
    client_id = public.my_client_id()
    and (public.my_role() = 'admin' or scope in ('files','deliverables'))
  )
  with check (
    client_id = public.my_client_id()
    and (public.my_role() = 'admin' or scope in ('files','deliverables'))
  );

-- ============================================================
-- After running this, create your two auth users (Authentication → Users → Add user),
-- each with raw_user_meta_data:
--   admin:   { "role": "admin",  "client_id": "celtic-elevator" }
--   client:  { "role": "client", "client_id": "celtic-elevator" }
-- (see SUPABASE_SETUP.md for the exact steps).
-- ============================================================
