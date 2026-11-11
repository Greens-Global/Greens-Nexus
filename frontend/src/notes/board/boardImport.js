// Import a picture or a PDF onto a Board to mark it up (Neil, 11/10/2026:
// "import pdf or paste image so we can mark it up hard"). Every PDF page is
// drawn to a PNG (pdfPage.js) and the pages stack top to bottom; a picture is
// placed as it is. Each goes in BEHIND the drawing and LOCKED, so pen strokes,
// boxes and comments land on top and a drag never moves the page (right-click
// > Unlock frees it). The files reach the private bucket the way every board
// picture does (Board's storeNewFiles) - never a data URL in the saved scene.
// Engine-free.
import { imageElement } from '../../lib/markup';

export const IMPORT_WIDTH = 1000;   // a page or picture is scaled down to this width, in board units
export const IMPORT_GAP = 40;       // between stacked pages

export const isPdfFile = (f) => /^application\/pdf$/i.test(f?.type || '') || /\.pdf$/i.test(f?.name || '');
export const isImageFile = (f) => /^image\//i.test(f?.type || '');
export const importable = (list) => [...(list || [])].filter((f) => isPdfFile(f) || isImageFile(f));

/** Boxes for pictures stacked top to bottom, centered on `x`, the first one's middle at `y`. */
export function stackBoxes(sizes, { x = 0, y = 0, width = IMPORT_WIDTH, gap = IMPORT_GAP } = {}) {
  const boxes = [];
  let top = null;
  for (const s of sizes || []) {
    const w0 = Math.max(1, Number(s?.width) || 800), h0 = Math.max(1, Number(s?.height) || 600);
    const k = Math.min(1, width / w0);
    const w = Math.round(w0 * k), h = Math.round(h0 * k);
    if (top === null) top = Math.round(y - h / 2);
    boxes.push({ x: Math.round(x - w / 2), y: top, width: w, height: h });
    top += h + gap;
  }
  return boxes;
}

/** The locked image elements for placed files: [{ fileId, width, height, name, page }]. Plain JSON. */
export function importElements(placed, at = {}) {
  const boxes = stackBoxes(placed, at);
  return (placed || []).map((p, i) => ({
    ...imageElement(p.fileId, boxes[i]),
    locked: true,
    customData: { nexusImport: { name: String(p.name || '').slice(0, 200), ...(p.page ? { page: p.page } : {}) } },
  }));
}

/** A Blob as a data URL (for the engine's files - Board's storeNewFiles uploads it and keeps the URL). */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** The words for what was placed: "3 Pages", "1 Picture", "2 Pages and 1 Picture". */
export function placedWords(pages, pictures) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return [part(pages, 'Page', 'Pages'), part(pictures, 'Picture', 'Pictures')].filter(Boolean).join(' and ');
}
