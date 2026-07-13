-- ============================================================
-- TJA CLIENT PORTAL — schema v3: let the client roster sync
-- Run in: SQL Editor → New query → paste → Run. Idempotent.
--
-- The app pushes the client roster to app_state under
-- (client_id='_registry', scope='clients'), but the table's CHECK
-- constraint only allowed dashboard/files/deliverables — so the
-- roster could NEVER reach Supabase (every push was rejected).
-- This adds 'clients' to the allowed scopes.
-- ============================================================
alter table public.app_state drop constraint if exists app_state_scope_check;
alter table public.app_state add constraint app_state_scope_check
  check (scope in ('dashboard','files','deliverables','clients'));
