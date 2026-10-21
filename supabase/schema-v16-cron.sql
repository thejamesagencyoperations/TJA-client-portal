-- v394 (2026-10-20): run the FREQUENT jobs from the database's own scheduler.
-- GitHub Actions only fires */5 and */10 schedules every few HOURS under load (plan-refresh and
-- the review-notification sweep were running every 2-6 h), so pg_cron calls the edge functions
-- directly via pg_net. The GitHub workflows stay as a backup; every job is idempotent.
-- The shared secret lives in Supabase Vault ("portal_cron_secret") and matches the CRON_SECRET
-- edge-function secret (see supabase/functions/_shared/cron-auth.ts). Never put it in this file.
--
-- One-time setup (already applied):
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   select vault.create_secret('<CRON_SECRET>', 'portal_cron_secret');

create or replace function public.portal_cron_call(fn text, payload jsonb default '{}'::jsonb)
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://sliutkbdpuimxxmvsbek.supabase.co/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-snapshot-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'portal_cron_secret')),
    body := payload,
    timeout_milliseconds := 120000);
$$;
revoke all on function public.portal_cron_call(text, jsonb) from public, anon, authenticated;

-- (re)schedule — cron.schedule with an existing name replaces it
select cron.schedule('portal-plan-refresh',  '*/5 * * * *',  $$ select public.portal_cron_call('plan-refresh') $$);
select cron.schedule('portal-review-sweep',  '*/10 * * * *', $$ select public.portal_cron_call('send-review-notification', '{"mode":"sweep"}'::jsonb) $$);
-- v395: Service Allocation Plans — refresh connected sheets + month rollover, hourly at :20
select cron.schedule('portal-sap-sweep', '20 * * * *', $$ select public.portal_cron_call('sap', '{"action":"sweep"}'::jsonb) $$);
-- v404: day-before deadline reminders — approved by Cameron 2026-10-21. 15:00 UTC = 8am Arizona (no DST).
select cron.schedule('portal-todo-reminders', '0 15 * * *', $$ select public.portal_cron_call('todo-reminders') $$);
