import { supabase } from '../../lib/supabase';

// Single storage bucket for all Investor Relations files (subscription docs,
// K-1s, PPMs, notices). Paths namespace the content, e.g. commitments/<fundId>/…
export const IR_BUCKET = 'ir-documents';

// PDF / Word / Excel / images by default — callers can pass their own list.
export const DEFAULT_ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
];

const MAX_BYTES = 25 * 1024 * 1024;

export function safeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Same contract as the InventoryManagement.jsx helper: resolves { url, error }.
export async function uploadToSupabase(file, bucket, path, allowedTypes = DEFAULT_ALLOWED_TYPES) {
  if (!supabase) return { url: '', error: 'Supabase not configured' };
  if (allowedTypes && allowedTypes.length && !allowedTypes.includes(file.type)) {
    return { url: '', error: 'File type not allowed — use PDF, Word, Excel, or an image' };
  }
  if (file.size > MAX_BYTES) return { url: '', error: 'File must be under 25 MB' };
  // cacheControl 1 year: paths are unique and files never change, so browsers
  // cache them immutably instead of revalidating on every visit.
  const { data: uploaded, error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error || !uploaded) return { url: '', error: error?.message || 'Upload failed' };
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(uploaded.path);
  return { url: urlData.publicUrl, error: null };
}
