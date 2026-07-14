-- ============================================================
-- TJA CLIENT PORTAL — schema v6: creative role + waiting room
-- Run in: SQL Editor → New query → paste → Run. Idempotent —
-- safe to run twice. Run scripts/backup-supabase.mjs FIRST.
--
-- FOLDS IN schema-v5 (which was never applied in prod — verified
-- 2026-07-14: the scope CHECK still rejected 'notifications').
-- You do NOT need to run v5 separately; this file covers it.
--
-- What this adds:
--   • A third role: 'creative' — mid-tier team members who can open
--     any client read-only and upload Present Docs deliverables into
--     a WAITING ROOM the client can never see. An admin (AM/PM)
--     releases drafts to the client with the Send button.
--   • Scope 'notifications' (from v5) — per-client feed for the
--     admin bell / Notification Center, cross-device.
--   • Scope 'deliverables_draft' — the waiting room. Client
--     invisibility of drafts is enforced HERE (RLS), not in the UI:
--     drafts live in a row the client's role can never select.
--   • Scope 'presence' — "who else is editing this client"
--     heartbeats. Staff-only; clients can neither read nor write it.
--
-- ROLLBACK (returns the backend to today's prod state = v1–v4):
--   alter table public.profiles drop constraint profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role in ('admin','client'));
--   alter table public.app_state drop constraint app_state_scope_check;
--   alter table public.app_state add constraint app_state_scope_check
--     check (scope in ('dashboard','files','deliverables','clients'));
--   drop policy if exists app_state_read on public.app_state;
--   create policy app_state_read on public.app_state
--     for select using (
--       public.my_role() = 'admin' or client_id = public.my_client_id());
--   drop policy if exists app_state_write on public.app_state;
--   create policy app_state_write on public.app_state
--     for all
--     using (public.my_role() = 'admin'
--       or (client_id = public.my_client_id() and scope in ('files','deliverables')))
--     with check (public.my_role() = 'admin'
--       or (client_id = public.my_client_id() and scope in ('files','deliverables')));
--   (Rollback requires no 'creative' profiles rows and no
--    deliverables_draft/notifications/presence rows to still exist —
--    delete them first or the re-added CHECKs will fail.)
-- ============================================================

-- ---- 1. profiles: allow the 'creative' role -------------------------
-- The prod CHECK was created inline (auto-named by Postgres), so we
-- can't drop it by a known name. Sweep every check constraint on
-- profiles that mentions "role", drop them, re-add under a stable name.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
  execute $q$alter table public.profiles add constraint profiles_role_check
    check (role in ('admin','client','creative'))$q$;
end $$;

-- ---- 2. app_state: new scopes ----------------------------------------
-- Same defensive sweep (the prod constraint is the inline auto-named
-- one; v5's named version never landed).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.app_state'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%scope%'
  loop
    execute format('alter table public.app_state drop constraint %I', c.conname);
  end loop;
  execute $q$alter table public.app_state add constraint app_state_scope_check
    check (scope in ('dashboard','files','deliverables','clients',
                     'notifications','deliverables_draft','presence'))$q$;
end $$;

-- ---- 3. READ policy ---------------------------------------------------
-- admin    → everything.
-- creative → everything (they open any client read-only, see the
--            waiting room, and need the '_registry' roster to use the
--            client picker).
-- client   → ONLY their own rows, and NEVER the draft or presence
--            scopes. This line is the waiting room's actual security
--            boundary — the UI hiding drafts is cosmetic by comparison.
drop policy if exists app_state_read on public.app_state;
create policy app_state_read on public.app_state
  for select using (
    public.my_role() in ('admin','creative')
    or (client_id = public.my_client_id()
        and scope not in ('deliverables_draft','presence'))
  );

-- ---- 4. WRITE policy ----------------------------------------------------
-- admin    → everything (includes presence heartbeats + releasing drafts).
-- creative → drafts for ANY client (their whole job) + notifications
--            (so their uploads surface in the admin bell).
-- client   → their own files / deliverables / notifications — exactly
--            today's behavior plus v5's notifications grant.
--
-- ⚠ DO NOT ever add 'deliverables_draft' to the client branch below.
--   A FOR ALL policy's USING clause also grants SELECT, so that one
--   edit would silently let clients read the waiting room and the
--   draft-invisibility guarantee dies. Enforced here, tested in the
--   verification block at the bottom.
drop policy if exists app_state_write on public.app_state;
create policy app_state_write on public.app_state
  for all
  using (
    public.my_role() = 'admin'
    or (public.my_role() = 'creative'
        and scope in ('deliverables_draft','notifications'))
    or (public.my_role() = 'client'
        and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  )
  with check (
    public.my_role() = 'admin'
    or (public.my_role() = 'creative'
        and scope in ('deliverables_draft','notifications'))
    or (public.my_role() = 'client'
        and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  );

-- (profiles_self_read is unchanged from v2: self or admin. Creatives
--  don't read other profiles; my_role()/my_client_id() are SECURITY
--  DEFINER (v4) so they work for every role regardless of policies.
--  The handle_new_user trigger already copies role verbatim from
--  user_metadata, so 'creative' users provision with no trigger change.)

-- ---- 5. Verify (read-only; safe to leave in) ---------------------------
-- Expect exactly the 7 scopes in the CHECK and the 3-branch policies.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('public.profiles'::regclass, 'public.app_state'::regclass)
  and contype = 'c';
select polname, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.app_state'::regclass;
