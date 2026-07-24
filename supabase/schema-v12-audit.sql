-- schema v12 — version / edit history (2026-07-24)
--
-- Adds an APPEND-ONLY audit_log table: "who changed what, when" across the portal.
-- Deliberately NOT an app_state scope — app_state is one row per (client_id, scope),
-- so an audit trail there would be a single ever-growing jsonb blob per client. A real
-- table gives cheap indexed pagination and lets us prune old rows.
--
-- STORAGE SHAPE (kept tiny on purpose): one row per edit BURST, holding only a
-- field-level diff, e.g.
--   changes = [{"p":"retainer.burn.contractedHours","f":"120","t":"140"}]
-- Values are truncated client-side (~120 chars). Full snapshots + rows older than
-- 45 days live in Google Drive (history-snapshot Edge Function), never here.
--
-- READ:   admin + manager only (clients/creatives must never see the trail).
-- INSERT: any signed-in portal user — a client submitting a review is a real audited
--         event. Attribution is written by the client, so treat actor_* as
--         "claimed by that session"; the service role writes machine events.
-- UPDATE/DELETE: NOBODY (no policy at all). Append-only. Archiving/pruning is done by
--         the service role, which bypasses RLS.
--
-- Run this once in the Supabase SQL editor. Re-running is safe.

create table if not exists public.audit_log (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  client_id    text        not null,             -- workspace the change belongs to ('_registry' for roster)
  scope        text,                             -- dashboard | deliverables | clients | …  (null for non-app_state events)
  actor_email  text,
  actor_name   text,
  actor_role   text,                             -- admin | manager | creative | media | client | system
  action       text        not null,             -- 'edit' or a semantic label ('deliverable.sent', 'assignments.synced', …)
  summary      text,                             -- short human line for the timeline
  changes      jsonb       not null default '[]'::jsonb,   -- [{p,f,t}, …] field-level diff
  n            int         not null default 0    -- number of changes (changes[] may be capped)
);

-- the two access patterns: one client's timeline, and the global/archive sweep by date
create index if not exists audit_log_client_ts_idx on public.audit_log (client_id, ts desc);
create index if not exists audit_log_ts_idx        on public.audit_log (ts);

alter table public.audit_log enable row level security;

-- READ — staff who manage clients. Creatives, paid-media and clients get nothing.
drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log
  for select using (public.my_role() in ('admin','manager'));

-- INSERT — any authenticated portal user may append their own activity.
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert with check (auth.uid() is not null);

-- (NO update/delete policies — the table is append-only for every non-service caller.)

-- ---- Verify (read-only) ----------------------------------------------
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'public.audit_log'::regclass order by polname;
