-- ============================================================
-- TJA CLIENT PORTAL — schema v4: FIX RLS INFINITE RECURSION
-- Run in: SQL Editor → New query → paste → Run. Idempotent.
--
-- THE BUG (introduced in schema-v2):
--   profiles_self_read calls public.my_role(), and my_role() SELECTs
--   from public.profiles. Reading profiles re-evaluates the policy,
--   which calls my_role() again, which reads profiles again … →
--   "stack depth limit exceeded" / "statement timeout" on EVERY
--   authenticated read. The app hid it by falling back to localStorage,
--   but it blocks the cloud push and cross-device sync.
--
-- THE FIX:
--   Make the two helper functions SECURITY DEFINER so they read
--   profiles with the owner's rights and DO NOT re-trigger RLS. This
--   is the standard Supabase pattern for exactly this recursion.
-- ============================================================

create or replace function public.my_client_id()
  returns text language sql stable
  security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid()
$$;

create or replace function public.my_role()
  returns text language sql stable
  security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- (Optional hardening) lock down who can execute them — anon/authenticated only.
revoke all on function public.my_client_id() from public;
revoke all on function public.my_role() from public;
grant execute on function public.my_client_id() to anon, authenticated;
grant execute on function public.my_role() to anon, authenticated;
