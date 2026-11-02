// Mark Up Anything (Notes whiteboard, Phase 2 - Neil, 11/02/2026).
//
// Any picture Nexus shows - a ticket's screenshot, a task's attachment, a
// walkthrough photo, a PDF page - can become a Board with the picture placed
// as its first element, titled "Mark Up: <where it came from>" and carrying a
// `source` that points back, so the finished markup can be attached to the
// task or ticket it was made from (Board.jsx's menu, api.attachMarkup).
//
// The picture is stored the way every board image is (board/files.js: the
// private task-files bucket under notes/boards/<noteId>/, the scene keeps the
// viewer URL, never a data URL), so a marked-up copy of a ticket photo stays
// as private as the photo. A PDF is rendered to a PNG first (board/pdfPage.js);
// the caller picks the page when there are several.
import { api } from '../api';
import { isOwnImageUrl } from './storageView';

export const MARKUP_KINDS = ['task', 'ticket', 'note', 'walkthrough', 'file'];
export const MARKUP_FRAME = 1200;      // the picture is scaled to fit this square, in board units
const LABEL_MAX = 200;
const ID_MAX = 100;

const IMAGE_RE = /^image\//i;
const PDF_RE = /^application\/pdf$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)($|\?)/i;
const PDF_EXT = /\.pdf($|\?)/i;

/** Can this be marked up? Takes a MIME type, a file name or a URL. */
export function canMarkUp(mimeOrName, name = '') {
  const probe = `${mimeOrName || ''} ${name || ''}`;
  return IMAGE_RE.test(mimeOrName || '') || PDF_RE.test(mimeOrName || '') || IMAGE_EXT.test(probe) || PDF_EXT.test(probe);
}
export const isPdfSource = (mimeOrName, name = '') => PDF_RE.test(mimeOrName || '') || PDF_EXT.test(`${mimeOrName || ''} ${name || ''}`);

const clip = (s, n) => String(s || '').trim().slice(0, n);

/** A clean `source` for the board row: a known kind with an id and label,
 *  else a plain file (the attachment's own name), which the API keeps too. */
export function markupSource(given, att = {}) {
  const kind = MARKUP_KINDS.includes(given?.kind) ? given.kind : 'file';
  const fallbackId = clip(att.id || att.url || att.name || 'file', ID_MAX) || 'file';
  const id = clip(kind === 'file' ? (given?.id || fallbackId) : given?.id, ID_MAX) || fallbackId;
  const label = clip(given?.label || att.name || 'Picture', LABEL_MAX) || 'Picture';
  const url = typeof given?.url === 'string' && /^\//.test(given.url) ? given.url.slice(0, 500) : '';
  return { kind, id, label, url };
}

/** The board's title for a markup. */
export const markupTitle = (source) => clip(`Mark Up: ${source?.label || 'Picture'}`, LABEL_MAX);

/** Where a picture of w x h sits so it fits the frame, centered on the origin. */
export function placeImage(width, height, frame = MARKUP_FRAME) {
  const w = Math.max(1, Number(width) || 1), h = Math.max(1, Number(height) || 1);
  const s = Math.min(1, frame / Math.max(w, h));
  const fw = Math.round(w * s), fh = Math.round(h * s);
  return { x: -Math.round(fw / 2), y: -Math.round(fh / 2), width: fw, height: fh };
}

const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const elementId = () => `mk${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** The engine's image element for a stored file. */
export function imageElement(fileId, box) {
  const now = Date.now();
  return {
    id: elementId(), type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null,
    x: box.x, y: box.y, width: box.width, height: box.height, angle: 0,
    strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: now, link: null, locked: false,
  };
}

function imageSize(blob) {
  return new Promise((resolve) => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Image === 'undefined') { resolve({ width: 0, height: 0 }); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

async function fetchPicture(imageUrl, mimeType) {
  if (imageUrl && typeof imageUrl === 'object' && typeof imageUrl.arrayBuffer === 'function') return imageUrl;   // a File / Blob
  const url = String(imageUrl || '');
  if (!url) throw new Error('There is no picture to mark up.');
  if (isOwnImageUrl(url)) {
    const { blob } = await api.viewerBlob(url);
    return blob;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('Could not read the picture.');
  const blob = await r.blob();
  return mimeType && !blob.type ? blob.slice(0, blob.size, mimeType) : blob;
}

const fileName = (source, ext) => `${markupTitle(source).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)}.${ext}`;

/**
 * openMarkup({ imageUrl, mimeType, name, source, page })
 *   imageUrl  - a URL (ours or not) or a File / Blob
 *   mimeType  - image/* or application/pdf (a name or URL extension works too)
 *   source    - { kind, id, label, url } - where it came from (markupSource cleans it)
 *   page      - the PDF page to render (1-based) when the picture is a PDF
 * Makes the board, stores the picture, places it, saves the scene and opens
 * the board. Resolves to the note; throws a readable Error.
 */
export async function openMarkup({ imageUrl, mimeType = '', name = '', source: given, page = 1, navigate = true } = {}) {
  const source = markupSource(given, { name, url: typeof imageUrl === 'string' ? imageUrl : '' });
  const [{ createBoard, openBoard }, { uploadBoardFile }, { emptyScene, serializeScene }] = await Promise.all([
    import('../notes/newBoard'), import('../notes/board/files'), import('../notes/board/scene'),
  ]);
  let blob, width, height, type;
  if (isPdfSource(mimeType, name || (typeof imageUrl === 'string' ? imageUrl : ''))) {
    const { renderPdfPage } = await import('../notes/board/pdfPage');
    const r = await renderPdfPage(imageUrl, page);
    blob = r.blob; width = r.width; height = r.height; type = 'image/png';
  } else {
    blob = await fetchPicture(imageUrl, mimeType);
    type = blob.type || mimeType || 'image/png';
    ({ width, height } = await imageSize(blob));
  }
  if (!IMAGE_RE.test(type)) throw new Error('Only a picture or a PDF page can be marked up.');
  const note = await createBoard({ title: markupTitle(source), source });
  try {
    const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const file = new File([blob], fileName(source, ext), { type });
    const meta = await uploadBoardFile(note.id, file);
    const box = placeImage(width || 800, height || 600);
    const scene = emptyScene('clean');
    scene.elements = [imageElement(meta.id, box)];
    scene.files = { [meta.id]: meta };
    const saved = await api.noteUpdate(note.id, { rev: note.rev, scene: serializeScene({ elements: scene.elements, appState: scene.appState, filesMeta: scene.files, look: 'clean' }) });
    if (navigate) openBoard(note.id);
    return saved || note;
  } catch (e) {
    // The board exists but is empty: still open it so nothing is lost, and say why.
    if (navigate) openBoard(note.id);
    throw new Error(`The board was made but the picture could not be placed: ${e?.message || 'upload failed'}`, { cause: e });
  }
}
