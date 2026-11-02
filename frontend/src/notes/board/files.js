// A Board's images (Notes whiteboard, Neil 11/02/2026).
//
// The engine keeps images in memory as data URLs; Nexus never saves one. A
// pasted, dropped or picked image goes browser -> the private `task-files`
// bucket under notes/boards/<noteId>/ through the Tasks uploader
// (storeTaskFile), exactly like a note's voice clip, and the scene keeps the
// file's URL. Reopening the board fetches each URL through the signed-in
// viewer (api.viewerBlob -> GET /files/view) and hands the engine a data URL.
// A file that will not load is skipped: the element stays, drawn as the
// engine's missing-image placeholder, and nothing else on the board is lost.
import { storeTaskFile } from '../../tasks/lib';
import { api } from '../../api';

const IMAGE_RE = /^image\//i;
// The engine's own cap for an image element is 2 MB after compression; keep
// uploads sane well under the Tasks 25 MB attachment limit.
export const BOARD_IMAGE_MAX = 10 * 1024 * 1024;

async function bytesOf(file) {
  if (typeof file.arrayBuffer === 'function') {
    try { return new Uint8Array(await file.arrayBuffer()); } catch { /* fall through */ }
  }
  // Older engines (and jsdom) have FileReader but no Blob.arrayBuffer.
  const buf = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
  return new Uint8Array(buf);
}

// FNV-1a over the bytes, two lanes, when SubtleCrypto is missing (a test
// runner, an old WebView): still a function of the content, so the same
// image pasted twice stays one file.
function fnv(bytes) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[(bytes.length - 1) - i], 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}${bytes.length.toString(16)}`;
}

/** The engine's file id: a hash of the bytes, so the same image pasted twice
 *  is one file. */
export async function boardFileId(file) {
  const bytes = await bytesOf(file);
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return fnv(bytes);
  }
}

export async function uploadBoardFile(noteId, file) {
  if (!file || !IMAGE_RE.test(file.type || '')) throw new Error('Only an image can go on a board.');
  if (file.size > BOARD_IMAGE_MAX) throw new Error('That image is larger than 10 MB.');
  const [id, url] = await Promise.all([boardFileId(file), storeTaskFile(file, undefined, `notes/boards/${noteId}`)]);
  if (!url) throw new Error('The image could not be stored.');
  return { id, mimeType: file.type, url, created: Date.now() };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** Scene file meta -> the engine's BinaryFiles (with data URLs). */
export async function loadBoardFiles(filesMeta) {
  const out = {};
  const entries = Object.entries(filesMeta || {});
  await Promise.all(entries.map(async ([key, meta]) => {
    if (!meta?.url) return;
    try {
      const { blob } = await api.viewerBlob(meta.url);
      const dataURL = await blobToDataUrl(blob);
      if (!dataURL) return;
      out[key] = { id: meta.id || key, mimeType: meta.mimeType || blob.type || 'image/png', dataURL, created: Number(meta.created) || Date.now() };
    } catch {
      // Skipped: the element keeps its place and the engine shows its missing-image mark.
    }
  }));
  return out;
}
