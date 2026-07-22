-- ============================================================
-- schema-v10 — the 'media' role (paid-media team)
--
-- Run this in the Supabase SQL editor. It does two things:
--   1. widens the profiles role CHECK so 'media' logins can be created
--   2. lets 'media' READ every client (staff-tier read)
--
-- Deliberately NO write policy for 'media'. Their one edit — setting a
-- Media Creative Asset Request's status — goes through the media-intake
-- Edge Function (service role), which bypasses RLS. So "view-only on all
-- client work" is enforced at the database, not merely hidden in the UI:
-- even a hand-crafted request from a media login cannot write dashboards,
-- files or deliverables.
-- ============================================================

-- 1. allow the new role -------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','client','creative','media'));

-- 2. read: media joins the staff read set (reads all clients) -----------
-- Unchanged from v7 except 'media' added to the staff branch. Clients still
-- read only their own rows and never the waiting room or presence.
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() in ('admin','manager','creative','media')
    or (client_id = public.my_client_id()
        and scope not in ('deliverables_draft','presence'))
  );

-- Note: app_state_insert / app_state_update / app_state_delete are NOT
-- touched — 'media' appears in none of them, which is the point.
