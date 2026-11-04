-- v407 (2026-11-04): Budget Controls — a server-owned scope per client ('budget').
-- Written only by the `budget` Edge Function (service role). RLS already lets a client READ its
-- own rows and never lets a client INSERT/UPDATE this scope (their write list is files /
-- deliverables / notifications), so only the scope CHECK needs the new name.
alter table public.app_state drop constraint if exists app_state_scope_check;
alter table public.app_state add constraint app_state_scope_check
  check (scope in ('dashboard','files','deliverables','clients','notifications',
                   'deliverables_draft','presence','media_intake','budget'));
