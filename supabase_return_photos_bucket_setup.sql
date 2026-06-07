-- Run this once in Supabase Dashboard → SQL Editor
-- Creates the 'return-photos' storage bucket used by Inventory Management's
-- return flow (InventoryContext.jsx → returnItem) and sets up RLS so the
-- browser-side Supabase client (anon key) can upload + read photos.
--
-- Without this bucket, returnItem() catches a "Bucket not found" error and
-- (as of the latest deploy) surfaces it as a toast — the return itself still
-- succeeds, but no photo gets attached.

insert into storage.buckets (id, name, public)
values ('return-photos', 'return-photos', true)
on conflict (id) do nothing;

-- Browser uploads use the anon key — actual access control (who can submit a
-- return at all) is already enforced server-side via Azure AD in the backend.
-- This policy just lets the storage layer accept those uploads.
drop policy if exists "anon_upload_return_photos" on storage.objects;
create policy "anon_upload_return_photos"
  on storage.objects for insert to anon
  with check (bucket_id = 'return-photos');

drop policy if exists "anon_read_return_photos" on storage.objects;
create policy "anon_read_return_photos"
  on storage.objects for select to anon
  using (bucket_id = 'return-photos');

-- Verify — should return one row with public = true
select id, name, public from storage.buckets where id = 'return-photos';
