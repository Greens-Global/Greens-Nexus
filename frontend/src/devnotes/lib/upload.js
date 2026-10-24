// Pin files go browser -> the PRIVATE qa-evidence bucket under
// dev-notes/<noteId>/<kind>-<timestamp>.<ext>, and the note keeps the
// canonical public-style URL (api.js shows it through /files/view). Same
// immutable caching as every other upload helper in the app.
import { supabase } from '../../lib/supabase';

export const BUCKET = 'qa-evidence';
export const KINDS = new Set(['screenshot', 'page', 'video', 'sheet', 'paste', 'after']);

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm', mp4: 'video/mp4' };

export function extOf(fileOrBlob, fallback = 'png') {
  const name = fileOrBlob?.name || '';
  const fromName = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (fromName && MIME[fromName]) return fromName;
  const type = fileOrBlob?.type || '';
  const hit = Object.entries(MIME).find(([, m]) => m === type);
  return hit ? hit[0] : fallback;
}

export async function uploadDevNoteFile(noteId, kind, blob, ext = extOf(blob)) {
  if (!supabase) throw new Error('File storage is not configured on this build.');
  if (!noteId || !KINDS.has(kind)) throw new Error('Bad upload target.');
  const path = `dev-notes/${noteId}/${kind}-${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET)
    .upload(path, blob, { contentType: blob.type || MIME[ext] || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Upload failed');
  return supabase.storage.from(BUCKET).getPublicUrl(data.path).data.publicUrl;
}

export const storageReady = () => !!supabase;
