// Construction media upload: browser -> Supabase Storage, then register the row.
//
// A new helper rather than a reuse. The three existing uploadToSupabase copies
// (views/InventoryManagement.jsx, lib/docBuilderUpload.js, investor/lib/upload.js)
// all cap at 10-25 MB and allow four image types; construction needs 100 MB
// video, HEIC off an iPhone, and audio. The parts that ARE shared are kept
// identical on purpose: the no-throw `{ url, error }` return, `upsert: false`,
// and `cacheControl: '31536000'`.
//
// Bytes go browser -> Supabase directly and never through the API. Routing a
// 100 MB clip through FastAPI would hold it in a gunicorn worker's memory for
// the length of a jobsite LTE upload.
import { supabase } from '../../lib/supabase';

export const BUCKET = 'construction-media';

// Mirrors backend/services/construction_storage.py. Two copies of a limit is a
// drift risk, so the client's job is only to fail FAST and kindly - the server
// re-validates every one of these and is the authority.
export const MAX_BYTES = {
  photo: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,   // matches routers/egnyte.py MAX_UPLOAD_BYTES
  audio: 25 * 1024 * 1024,
};

export const ALLOWED_MIME = {
  photo: ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav'],
};

const HEIC = ['image/heic', 'image/heif'];

// 2 MB, the same ceiling the Task module uses for inline attachments
// (tasks/lib.js, CreateTaskModal.jsx, QuickCreateTask.jsx, TaskDetailDrawer.jsx
// all hardcode it). Only consulted when Supabase is unconfigured - see
// uploadConstructionMedia.
export const MAX_INLINE = 2 * 1024 * 1024;

/** File -> base64 data: URL, or '' if it cannot be read. Never throws: a
 *  failed read is a per-file problem the worker can retry, not a crash. */
function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => resolve('');
    r.readAsDataURL(file);
  });
}

/** photo | video | audio | '' - derived from the MIME type, since a phone's
 *  file picker returns everything through one input. */
export function kindOf(file) {
  const t = (file?.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'photo';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  // iOS sometimes hands over a .mov with an empty type. Fall back to the
  // extension rather than rejecting a valid clip.
  const ext = (file?.name || '').split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(ext)) return 'photo';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'ogg', 'wav', 'weba'].includes(ext)) return 'audio';
  return '';
}

/** '' when acceptable, else a message written for a worker holding a phone.
 *  It names the real size and the real limit: "Upload failed" on a jobsite
 *  means the day's update simply never gets filed. */
export function validate(file) {
  const kind = kindOf(file);
  if (!kind) return 'That file type is not supported here.';
  const mime = (file.type || '').toLowerCase();
  if (mime && !ALLOWED_MIME[kind].includes(mime)) return `${mime} is not a supported ${kind} format.`;
  if (!file.size) return 'That file is empty.';
  const cap = MAX_BYTES[kind];
  if (file.size > cap) {
    const mb = (n) => Math.round(n / 1024 / 1024);
    return `That ${kind} is ${mb(file.size)} MB. The limit is ${mb(cap)} MB - `
      + (kind === 'video' ? 'record a shorter clip and try again.' : 'try a smaller file.');
  }
  return '';
}

// ── EXIF ────────────────────────────────────────────────────────────────────
/** { takenAt, latitude, longitude } - all optional.
 *
 *  `takenAt` is the whole reason this exists. A worker photographs at 09:13 and
 *  uploads at 21:40 when signal comes back; a report that dates that work to
 *  21:40 is wrong, and on a delay claim it is wrong in a way that costs money.
 *  Never throws - a photo with no EXIF is normal, not an error. */
export async function readExif(file) {
  if (kindOf(file) !== 'photo') return {};
  try {
    const { parse } = await import('exifr');
    const d = await parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'] });
    if (!d) return {};
    const taken = d.DateTimeOriginal || d.CreateDate;
    return {
      takenAt: taken instanceof Date && !Number.isNaN(+taken) ? taken.toISOString() : '',
      latitude: Number.isFinite(d.latitude) ? d.latitude : undefined,
      longitude: Number.isFinite(d.longitude) ? d.longitude : undefined,
    };
  } catch {
    return {};   // stripped EXIF, an odd encoder, a screenshot - all fine
  }
}

// ── HEIC ────────────────────────────────────────────────────────────────────
/** HEIC/HEIF -> JPEG for the serving copy. Anything else passes through.
 *
 *  HEIC is the iPhone default and most browsers cannot render it, so the app
 *  grid and the report PDF would show broken images. Conversion is best effort:
 *  if it fails the ORIGINAL is uploaded rather than nothing, because a photo
 *  that only Egnyte can open still beats a lost photo. */
export async function toWebSafe(file) {
  if (!HEIC.includes((file.type || '').toLowerCase())) return file;
  try {
    const heic2any = (await import('heic2any')).default;
    const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    const out = Array.isArray(blob) ? blob[0] : blob;
    const name = (file.name || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';
    return new File([out], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

// ── Upload ──────────────────────────────────────────────────────────────────
const safeExt = (file) => {
  const e = (file.name || '').split('.').pop();
  return (e && /^[a-z0-9]{1,5}$/i.test(e) ? e : 'bin').toLowerCase();
};

/** Upload one file and return what POST /construction/logs/{id}/media needs.
 *
 *  Returns `{ payload, error }`, never throws - the same contract every other
 *  uploader in this codebase uses, so a caller can render the error inline
 *  instead of wrapping each call in a try/catch.
 *
 *  The object key is a client-generated uuid, NOT the worker's filename. The
 *  human-readable name is the Egnyte side's job (see construction_storage.py);
 *  this bucket is addressed only by URL from the app and the PDF, and an id key
 *  means a link already printed into a published report cannot break when the
 *  file is renamed or re-filed. */
export async function uploadConstructionMedia(file, { projectId }) {
  const invalid = validate(file);
  if (invalid) return { payload: null, error: invalid };

  const kind = kindOf(file);
  // EXIF is read from the ORIGINAL - conversion drops it.
  const exif = await readExif(file);
  const upload = await toWebSafe(file);

  // Shared by both paths below. The SERVING size and type, not the original's:
  // the backend already validated the original against its own cap, and sending
  // the converted numbers keeps the stored row honest about what the URL
  // actually serves.
  const common = {
    kind,
    mime_type: upload.type || file.type || '',
    size_bytes: upload.size,
    original_name: file.name || '',
    taken_at: exif.takenAt || '',
    ...(exif.latitude !== undefined ? { gps_latitude: exif.latitude } : {}),
    ...(exif.longitude !== undefined ? { gps_longitude: exif.longitude } : {}),
  };

  // ── No storage configured: inline the bytes ───────────────────────────────
  // This is the Task module's mechanism, not a local hack - tasks/lib.js and
  // CreateTaskModal.jsx have always stored small attachments as a base64 data:
  // URL in the row, with the same 2 MB ceiling. Reusing it means the whole
  // construction flow (capture -> submit -> review -> report) is exercisable on
  // a laptop with nothing but SQLite, which is how the Task module is testable
  // and this one was not.
  //
  // It CANNOT engage on dev or prod: both set VITE_SUPABASE_URL and
  // VITE_SUPABASE_ANON_KEY, so `supabase` is non-null and the branch below runs
  // instead. So there is nothing to revert before a PR.
  //
  // The ceiling matters more here than in tasks: construction allows 100 MB
  // video, and base64 inflates by ~33%, so inlining a clip would put tens of
  // megabytes in a single row and ship it to every client that lists the log.
  if (!supabase) {
    if (upload.size > MAX_INLINE) {
      return {
        payload: null,
        error: `Storage is not connected, so only files under ${Math.round(MAX_INLINE / 1024 / 1024)} MB can be attached right now. Your notes, crew size and hours will still save.`,
      };
    }
    const dataUrl = await readAsDataUrl(upload);
    if (!dataUrl) return { payload: null, error: 'Could not read that file. Try attaching it again.' };
    // storage_path stays empty on purpose: there is no Supabase object, and a
    // synthesized path would describe one that does not exist.
    return { error: null, payload: { ...common, storage_path: '', url: dataUrl } };
  }

  // ── Normal path: browser -> Supabase ──────────────────────────────────────
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const path = `construction/${projectId}/${id}.${safeExt(upload)}`;

  const { data, error } = await supabase.storage.from(BUCKET).upload(path, upload, {
    contentType: upload.type || 'application/octet-stream',
    upsert: false,
    cacheControl: '31536000',   // ids are unique, so the object is immutable
  });
  if (error || !data) return { payload: null, error: error?.message || 'Upload failed' };

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);

  return { error: null, payload: { ...common, storage_path: data.path, url: pub.publicUrl } };
}

/** Any file kind from a clipboard paste - photos, but also a dragged-in clip.
 *  Copied from egnyte/lib.js rather than tasks/lib.js: the task and inventory
 *  versions filter to `image/` only, which would silently drop a pasted video. */
export function filesFromPaste(e) {
  const out = [];
  for (const item of e.clipboardData?.items || []) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (!f) continue;
    out.push(f.name ? f : new File([f], `paste-${Date.now()}.${(f.type.split('/')[1] || 'bin')}`, { type: f.type }));
  }
  return out;
}
