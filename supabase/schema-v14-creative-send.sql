-- ============================================================
-- schema-v14 — let CREATIVES send (release) deliverables to the client
--
-- Run in: Supabase SQL Editor → New query → paste → Run. Idempotent.
--
-- WHY: creatives keep uploading to the waiting room (deliverables_draft), but Cameron now also
-- wants them to be able to hit "Send to client" themselves as a separate step (2026-07-28).
-- "Send" moves the item from the draft scope into the 'deliverables' (client-visible) scope —
-- a client-side pushScopeNow write. Until now RLS only let creatives write
-- 'deliverables_draft' + 'notifications', so a creative Send was rejected at the database.
--
-- This adds 'deliverables' to the creative branch of the INSERT + UPDATE policies. Creatives
-- still CANNOT delete (delete policy is admin-only, unchanged) and still cannot touch
-- dashboards/files/profiles. Trade-off: a creative can now write any client's 'deliverables'
-- row (they could already produce the content as a draft); if tighter scoping is ever needed,
-- move the draft->sent move behind a service-role Edge Function instead of widening RLS.
--
-- Mirrors the current policies (schema-v7 + v10 read); only the creative scope-list changes.
-- ============================================================

drop policy if exists app_state_insert on public.app_state;
create policy app_state_insert on public.app_state
  for insert with check (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables','deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  );

drop policy if exists app_state_update on public.app_state;
create policy app_state_update on public.app_state
  for update using (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables','deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  ) with check (
    public.my_role() in ('admin','manager')
    or (public.my_role() = 'creative' and scope in ('deliverables','deliverables_draft','notifications'))
    or (public.my_role() = 'client' and client_id = public.my_client_id()
        and scope in ('files','deliverables','notifications'))
  );

-- DELETE policy unchanged (admin only). Verify:
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as check_expr
from pg_policy where polrelid = 'public.app_state'::regclass order by polname;
