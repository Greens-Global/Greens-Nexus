// Item Management - Photo upload to Supabase storage and Ctrl+V clipboard paste.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { supabase } from '../../lib/supabase';
import { toViewUrl } from '../../lib/storageView';

// First image on a paste event (screenshot Ctrl+V) as an upload-ready File -
// wire onto photo modals so every upload spot also accepts a pasted image.
export function imageFromPaste(e) {
  for (const it of e.clipboardData?.items || []) {
    if (it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) return blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' });
    }
  }
  return null;
}

export async function uploadToSupabase(file, bucket, path) {
  if (!supabase) return { url: '', error: 'Supabase not configured' };
  const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!ALLOWED.includes(file.type)) return { url: '', error: 'Only JPEG, PNG, GIF, or WebP images allowed' };
  if (file.size > 10 * 1024 * 1024) return { url: '', error: 'Photo must be under 10 MB' };
  // cacheControl 1 year: paths are unique and files never change, so browsers
  // should cache them immutably instead of revalidating every page visit
  const { data: uploaded, error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error || !uploaded) return { url: '', error: error?.message || 'Upload failed' };
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(uploaded.path);
  return { url: toViewUrl(urlData.publicUrl), error: null };
}
