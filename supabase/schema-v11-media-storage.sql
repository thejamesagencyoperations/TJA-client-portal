-- ============================================================
-- schema-v11 — storage bucket for Media Creative Asset Request uploads
--
-- Run this ONCE in the Supabase SQL editor. It lets clients attach an actual
-- file (jpg / png / mp4 / pdf …) to a media request instead of only a link.
-- Files land in the "media-intake" bucket; the submission stores the public URL.
-- ============================================================

-- 1. the bucket (public read — the stored URL is what the submission links to)
insert into storage.buckets (id, name, public)
values ('media-intake', 'media-intake', true)
on conflict (id) do nothing;

-- 2. any signed-in user (a client or staff) may UPLOAD to this bucket
drop policy if exists media_intake_insert on storage.objects;
create policy media_intake_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media-intake');

-- 3. the bucket is public-read (anyone with the unguessable URL can view the asset)
drop policy if exists media_intake_read on storage.objects;
create policy media_intake_read on storage.objects
  for select using (bucket_id = 'media-intake');
