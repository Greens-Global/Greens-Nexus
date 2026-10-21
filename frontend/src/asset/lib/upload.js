// Asset Management files: browser -> Supabase Storage, URL on the record.
//
// Until Oct 2026 every photo and document was a base64 data URL INSIDE the
// workspace JSON, so each save and each load carried every file in the
// portfolio and the per-keystroke localStorage cache quietly stopped past 5 MB.
// Files now go to the PRIVATE `asset-files` bucket (in PROTECTED_BUCKETS on
// both sides; served through /files/view) and the record keeps the URL - the
// task-files pattern (tasks/lib.js). Bytes go browser -> Supabase directly,
// never through the API.
//
// With Supabase unconfigured (a local backend with no storage) the helpers fall
// back to a data URL so local work keeps going; the server accepts a data URL
// only when storage is unconfigured there too.
import { supabase } from '../../lib/supabase';
import { toViewUrl } from '../../lib/storageView';
import { resizeImageToDataUrl, fileToDataUrl } from './format.js';

export const BUCKET = 'asset-files';
export const MAX_BYTES = 25 * 1024 * 1024;
const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

export function storageReady() {
  return !!supabase;
}

/** A data: URL as a File (a resized photo back into bytes for the upload). */
export function dataUrlToFile(dataUrl, name) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const type = m[1] || 'application/octet-stream';
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new File([bytes], name, { type });
}

const safeExt = (file) => {
  const fromName = (file.name || '').split('.').pop()?.toLowerCase() || '';
  const ext = /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : (file.type || '').split('/').pop() || 'bin';
  return ext === 'jpeg' ? 'jpg' : ext;
};

/** Upload one file; `{ url, error }`, never throws. `kind` is the folder
 *  ('photos' | 'documents'); `propertyId` keeps a property's files together. */
export async function uploadAssetFile(file, { propertyId = '', kind = 'documents' } = {}) {
  if (!supabase) return { url: '', error: 'Storage is not configured' };
  if (!file || !file.size) return { url: '', error: 'That file is empty.' };
  if (file.size > MAX_BYTES) return { url: '', error: `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is 25 MB.` };
  const path = `${kind}/${propertyId || 'unfiled'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt(file)}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) return { url: '', error: error?.message || 'Upload failed' };
  return { url: toViewUrl(supabase.storage.from(BUCKET).getPublicUrl(data.path).data.publicUrl), error: null };
}

/** An asset photo: downscaled to a 1600px JPEG, stored, its URL returned. Throws on
 *  an unreadable image (callers count those). */
export async function storeAssetImage(file, propertyId) {
  const dataUrl = await resizeImageToDataUrl(file, 1600, 0.85);
  if (!supabase) return dataUrl;
  const jpeg = dataUrlToFile(dataUrl, (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg');
  const { url, error } = await uploadAssetFile(jpeg, { propertyId, kind: 'photos' });
  if (error) throw new Error(error);
  return url;
}

/** A record's document (invoice, report, warranty): stored as is; `{ url, error }`. */
export async function storeAssetDocument(file, propertyId) {
  if (file?.type && !DOC_TYPES.includes(file.type) && !file.type.startsWith('image/')) {
    return { url: '', error: 'Use a PDF, image, Word, Excel, CSV or text file.' };
  }
  if (!supabase) {
    try { return { url: await fileToDataUrl(file), error: null }; } catch { return { url: '', error: 'Could not read that file.' }; }
  }
  return uploadAssetFile(file, { propertyId, kind: 'documents' });
}
