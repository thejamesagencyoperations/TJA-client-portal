-- schema v8 — enable Realtime on app_state (2026-07-20)
--
-- The live auto-refresh (v260) subscribes to postgres_changes on app_state
-- (assets/js/supabase-sync.js subscribeScope). Supabase only emits those
-- events for tables in the `supabase_realtime` publication. Without this,
-- the subscribe() call SUCCEEDS SILENTLY but no events ever arrive and tabs
-- fall back to the slow 30s poll — no error anywhere.
--
-- Cameron ran this by hand in the SQL editor on 2026-07-20 ("just ran it!");
-- this file records it so a project rebuild doesn't silently lose Realtime.
-- Re-running errors harmlessly if the table is already in the publication —
-- check first with:
--   select * from pg_publication_tables where pubname = 'supabase_realtime';

alter publication supabase_realtime add table public.app_state;

-- RLS still applies to Realtime: a subscriber only receives events for rows
-- their policies let them SELECT, so a client can't observe other clients.
