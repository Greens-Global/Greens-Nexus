-- Run this once in Supabase Dashboard -> SQL Editor, on EACH project that needs
-- it (dev first, then prod as part of the release - see docs/RELEASE-CHECKLIST.md
-- step 7). Creates the 'document-images' storage bucket used by the Documents
-- module and sets up RLS so the browser-side Supabase client (anon key) can
-- upload into it.
--
-- Without this bucket every upload in the module fails with "Bucket not found":
--   * letterhead logos          - DocumentBuilder.jsx uploadLhLogo(),
--                                 DocumentTemplates.jsx (Templates -> Letterheads)
--   * images placed in the body - DocumentBuilder.jsx (Insert -> Image, Ctrl+V)
--   * images pulled out of an imported Word file
--                               - DocumentBuilder.jsx / DocumentsBrowser.jsx
-- Sagar, Sep 17: hit on dev while adding a letterhead logo.

insert into storage.buckets (id, name, public)
values ('document-images', 'document-images', true)
on conflict (id) do nothing;

-- Browser uploads use the anon key. Who may author a document at all is already
-- enforced server-side via Azure AD in the backend; this policy only lets the
-- storage layer accept those uploads.
drop policy if exists "anon_upload_document_images" on storage.objects;
create policy "anon_upload_document_images"
  on storage.objects for insert to anon
  with check (bucket_id = 'document-images');

-- NOTE: deliberately NO anon SELECT policy. The bucket is public, so the
-- getPublicUrl() links embedded in documents keep working, but without a SELECT
-- policy the objects cannot be ENUMERATED with the anon key. This matches the
-- Aug 13 hardening that dropped the broad anon_read_* policies from
-- checkout-photos / item-photos / return-photos (docs/SECURITY-TODO.md).

-- Verify - should return one row with public = true
select id, name, public from storage.buckets where id = 'document-images';
