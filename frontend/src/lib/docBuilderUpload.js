import { supabase } from './supabase';

// Same client-side upload pattern as InventoryManagement.jsx's uploadToSupabase
// (public bucket, cacheControl: '31536000', returns a public URL) — duplicated
// locally rather than imported since that file isn't ours to touch (see
// CLAUDE.md file ownership) and it doesn't export the helper.
export async function uploadToSupabase(file, bucket, path) {
  if (!supabase) return { url: '', error: 'Supabase not configured' };
  const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!ALLOWED.includes(file.type)) return { url: '', error: 'Only JPEG, PNG, GIF, or WebP images allowed' };
  if (file.size > 10 * 1024 * 1024) return { url: '', error: 'Image must be under 10 MB' };
  const { data: uploaded, error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error || !uploaded) return { url: '', error: error?.message || 'Upload failed' };
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(uploaded.path);
  return { url: urlData.publicUrl, error: null };
}

// Same shape as InventoryManagement.jsx's imageFromPaste — pulls the first
// image out of a clipboard paste event, giving nameless blobs a filename
// (Supabase needs a path).
export function imageFromPaste(e) {
  for (const it of e.clipboardData?.items || []) {
    if (it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) return blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' });
    }
  }
  return null;
}
