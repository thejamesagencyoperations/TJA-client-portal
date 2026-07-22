-- schema v9 — paid-media creative intake (2026-07-21)
--
-- Adds a 'media_intake' scope to app_state: clients submit creative-asset
-- requests to the paid-media team from the portal (the "reverse Present Docs").
-- One row per client (client_id, scope='media_intake'), data = { submissions: [...] }.
--
-- READ: staff (admin/manager/creative) already read every scope, and clients
--       already read their OWN client_id rows — so no read-policy change is
--       needed; adding the scope to the CHECK constraint is enough.
-- WRITE: goes through the media-intake Edge Function (service role), which gates
--       by caller role — so no client-write RLS policy change is needed either.
--       The CHECK constraint applies to ALL writers (incl. service role), so the
--       scope MUST be listed here.
--
-- Run this once in the Supabase SQL editor. Re-running is safe.

alter table public.app_state drop constraint if exists app_state_scope_check;
alter table public.app_state add constraint app_state_scope_check
  check (scope in ('dashboard','files','deliverables','clients',
                   'notifications','deliverables_draft','presence','media_intake'));
