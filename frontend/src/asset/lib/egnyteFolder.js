// A property's PINNED Egnyte folder (Neil, 11/03/2026: "Should a property be
// able to pin its exact Egnyte folder instead of matching by name?" - yes).
// The row keeps `egnyteFolder` (a path); the server checks a changed value on
// the row save (routers/property_assets._check_egnyte_folder, through
// services/egnyte.normalize_pinned_folder) and the construction filer files a
// property job's photos there before any name match - and holds them, never
// guessing, while a pinned folder is missing. This file is the screen's side:
// the same normalizing, so the tab's copy reads what the server stores, and a
// hint before the save.

const WEB_PATH_MARK = '#storage/files/1';

export const egnyteFolderOf = (asset) => String((asset && asset.egnyteFolder) || '').trim();

/** The path as the server stores it: '' for none, else one leading slash, one
 *  slash between segments, each segment trimmed. A pasted Egnyte folder link
 *  (`.../app/index.do#storage/files/1/Shared/...`) becomes its path. */
export function normalizeEgnyteFolder(text) {
  let raw = String(text || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    const at = raw.indexOf(WEB_PATH_MARK);
    if (at < 0) return raw;   // not a folder link - egnyteFolderProblem says so
    raw = raw.slice(at + WEB_PATH_MARK.length);
    try { raw = decodeURIComponent(raw); } catch { /* keep it as typed */ }
  }
  const segs = raw.replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  return segs.length ? '/' + segs.join('/') : '';
}

/** '' when the value may be saved, else what to fix (the server has the
 *  final word). `roots` - where a pinned folder may live - is known once Find
 *  Folder has answered; before that only the shape is checked. */
export function egnyteFolderProblem(text, roots = []) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) && !raw.includes(WEB_PATH_MARK)) return "Paste the folder's path (it starts with /Shared) or its Egnyte folder link.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'The path has a character a folder name cannot hold.';
  const p = normalizeEgnyteFolder(raw);
  if (p.split('/').some((s) => s === '.' || s === '..')) return "The path may not contain '..' or '.'.";
  const list = (roots || []).filter(Boolean);
  if (list.length && !list.some((r) => p.toLowerCase().startsWith(String(r).toLowerCase().replace(/\/+$/, '') + '/'))) {
    return `The folder must be inside ${list.join(' or ')}.`;
  }
  return '';
}

/** The words for how Find Folder rated a candidate. */
export const HOW_WORDS = { exact: 'Same Name', site: 'Same Site', contains: 'Name Contains' };
