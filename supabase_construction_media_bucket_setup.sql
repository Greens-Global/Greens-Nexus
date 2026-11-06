-- Run this once in Supabase Dashboard -> SQL Editor, on DEV and on PROD.
-- Creates the PRIVATE 'construction-media' storage bucket every Construction
-- file goes to: daily-log photos, video and voice notes, drawings, signed
-- subcontracts and lien waivers (frontend/src/construction/lib/upload.js).
-- On 11/06/2026 it did not exist on dev (storage.buckets), so every
-- construction upload there failed with "Bucket not found".
--
-- PRIVATE (CLAUDE.md "Evidence buckets are PRIVATE"): browsers never read it
-- directly - api.js rewrites each canonical URL to GET /files/view, which
-- signs it after login (routers/files.py PROTECTED_BUCKETS already lists it).
-- So there is NO anon read policy, only the upload one the browser needs;
-- who may attach a file to a job is enforced by the API on every save.

insert into storage.buckets (id, name, public)
values ('construction-media', 'construction-media', false)
on conflict (id) do update set public = false;

drop policy if exists "anon_upload_construction_media" on storage.objects;
create policy "anon_upload_construction_media"
  on storage.objects for insert to anon
  with check (bucket_id = 'construction-media');

-- Verify - should return one row with public = false
select id, name, public from storage.buckets where id = 'construction-media';
