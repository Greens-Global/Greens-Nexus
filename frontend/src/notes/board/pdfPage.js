// A PDF page as a picture, for marking it up on a Board (Neil, 11/02/2026).
// pdfjs-dist is already in the bundle (vendor-pdf, the Documents and Nexus
// Sign screens); it is imported lazily here so nothing loads until someone
// asks. Our own storage is fetched through the signed viewer (api.viewerBlob)
// and a File picked on the device is read as is; any other address is
// refused - a markup never fetches from somewhere that is not ours.
import { api } from '../../api';
import { isOwnImageUrl } from '../../lib/storageView';

export const PDF_RENDER_SCALE = 1.6;    // the scale Nexus Sign renders at - crisp on a 2x screen
export const PDF_PAGES_MAX = 40;        // the picker never lists more than this

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  }
  return pdfjs;
}

// Blob -> ArrayBuffer; jsdom and old WebViews have FileReader but no Blob.arrayBuffer.
function blobBytes(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsArrayBuffer(blob);
  });
}

async function bytesOf(src) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return blobBytes(src);   // a File picked on the device
  const url = String(src || '');
  if (!url) throw new Error('No PDF to read.');
  if (!isOwnImageUrl(url)) throw new Error('Only a PDF stored in Nexus can be marked up.');
  const { blob } = await api.viewerBlob(url);
  return blobBytes(blob);
}

async function open(src) {
  const pdfjs = await loadPdfjs();
  const data = await bytesOf(src);
  return pdfjs.getDocument({ data }).promise;
}

/** How many pages the PDF has (the picker lists PDF_PAGES_MAX at most and says so). */
export async function pdfPageCount(src) {
  const pdf = await open(src);
  return pdf.numPages || 0;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the page.'))), 'image/png');
      return;
    }
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const bin = atob(dataUrl.split(',')[1] || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: 'image/png' }));
    } catch (e) { reject(e); }
  });
}

async function drawPage(pdf, n, scale) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  const blob = await canvasToBlob(canvas);
  return { blob, width: canvas.width, height: canvas.height, page: n };
}

/** One page (1-based) rendered to a PNG: { blob, width, height }. */
export async function renderPdfPage(src, pageNumber = 1, scale = PDF_RENDER_SCALE) {
  const pdf = await open(src);
  const n = Math.min(Math.max(1, Number(pageNumber) || 1), pdf.numPages || 1);
  return { ...(await drawPage(pdf, n, scale)), pages: pdf.numPages || 1 };
}

/** The first `max` pages, the PDF read once (Import on a Board): { pages: [{ blob, width, height, page }], total }. */
export async function renderPdfPages(src, { max = PDF_PAGES_MAX, scale = PDF_RENDER_SCALE } = {}) {
  const pdf = await open(src);
  const total = pdf.numPages || 1;
  const pages = [];
  for (let n = 1; n <= Math.min(total, max); n += 1) pages.push(await drawPage(pdf, n, scale));
  return { pages, total };
}
