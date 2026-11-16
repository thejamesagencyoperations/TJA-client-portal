-- ============================================================
-- schema-v20 — ASK TJA chat log (2026-11-16)
--
-- Every Ask TJA exchange (AI answer, quick answer, "send to my AM" handoff) is logged here so
-- staff can review them in Admin Center → Ask TJA, and so the per-user daily AI limit can be
-- counted on the server.
--
-- Only the `ask-tja` Edge Function (service role) reads or writes this table. RLS is ON with
-- NO policies, so no browser login — client or staff — can read or write it directly; staff
-- read it through the function, which checks their role.
--
-- The on/off switch, daily limit and display name live in the staff-only internal row
-- app_state(client_id '_ask_tja', scope 'clients'), which clients can't read under RLS.
-- ============================================================

create table if not exists public.ask_tja_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  client_id   text not null,
  user_id     uuid,
  email       text not null default '',
  role        text not null default '',
  kind        text not null check (kind in ('ai', 'quick', 'handoff', 'limited', 'error')),
  question    text not null default '',
  answer      text not null default '',
  unanswered  boolean not null default false,   -- the assistant couldn't answer from portal data
  preview     boolean not null default false,   -- asked by staff in "Staff preview"
  model       text not null default '',
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0
);

create index if not exists ask_tja_log_client_idx on public.ask_tja_log (client_id, created_at desc);
create index if not exists ask_tja_log_user_day_idx on public.ask_tja_log (user_id, kind, created_at);

alter table public.ask_tja_log enable row level security;
-- (no policies on purpose — service role only)
revoke all on public.ask_tja_log from anon, authenticated;
