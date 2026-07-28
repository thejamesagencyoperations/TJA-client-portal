-- schema-v13 — invite-link expiry tracking
--
-- Adds profiles.invite_sent_at: the timestamp of the LAST invite/signup link we issued for
-- this login. manage-users stamps it on every invite + reinvite, and the Admin Center reads
-- it to show "Invited — link expired" (red) once the link is older than 24 hours, instead of
-- the amber "Invited — not accepted" indefinitely.
--
-- Safe to re-run. Existing rows stay NULL; the Admin Center falls back to GoTrue's invited_at
-- for those, so nothing breaks before/without a backfill.
--
-- Run this in the Supabase SQL editor, then deploy the function:
--   supabase functions deploy manage-users --use-api

alter table public.profiles add column if not exists invite_sent_at timestamptz;
