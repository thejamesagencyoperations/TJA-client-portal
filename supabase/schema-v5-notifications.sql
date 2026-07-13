-- ============================================================
-- TJA CLIENT PORTAL — schema v5: notifications feed
-- Run in: SQL Editor → New query → paste → Run. Idempotent.
--
-- Adds a per-client "notifications" feed to app_state so a client's
-- Present Docs actions (review submitted, revisions requested, comments)
-- surface in the admin Message Center — grouped by client, cross-device.
--
--   • Extends the scope CHECK to allow 'notifications'.
--   • Lets a CLIENT write their own notifications feed (like files /
--     deliverables). Admins already read every client's rows via
--     my_role() = 'admin', so one query (scope = 'notifications')
--     returns the whole queue.
-- ============================================================

alter table public.app_state drop constraint if exists app_state_scope_check;
alter table public.app_state add constraint app_state_scope_check
  check (scope in ('dashboard','files','deliverables','clients','notifications'));

drop policy if exists app_state_write on public.app_state;
create policy app_state_write on public.app_state
  for all
  using (
    public.my_role() = 'admin'
    or (client_id = public.my_client_id() and scope in ('files','deliverables','notifications'))
  )
  with check (
    public.my_role() = 'admin'
    or (client_id = public.my_client_id() and scope in ('files','deliverables','notifications'))
  );
