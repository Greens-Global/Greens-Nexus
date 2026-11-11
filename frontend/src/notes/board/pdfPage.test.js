// A PDF page as a PNG for marking up (11/02/2026), with pdfjs stood in.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pdfjs = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const page = { getViewport: ({ scale }) => ({ width: 100 * scale, height: 150 * scale }), render };
  const doc = { numPages: 3, getPage: vi.fn(async () => page) };
  return { GlobalWorkerOptions: {}, getDocument: vi.fn(() => ({ promise: Promise.resolve(doc) })), render, doc };
});
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjs);
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }));
const apiMock = vi.hoisted(() => ({ viewerBlob: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../lib/storageView', () => ({ isOwnImageUrl: (u) => /supabase\.co\/storage/.test(u || '') }));

import { pdfPageCount, renderPdfPage, PDF_RENDER_SCALE } from './pdfPage';

const OWN = 'https://x.supabase.co/storage/v1/object/public/task-files/tasks/plan.pdf';

describe('pdfPage', () => {
  beforeEach(() => {
    apiMock.viewerBlob.mockReset();
    apiMock.viewerBlob.mockResolvedValue({ blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }) });
    pdfjs.getDocument.mockClear(); pdfjs.render.mockClear(); pdfjs.doc.getPage.mockClear();
    // jsdom has no canvas drawing: stand in for the two calls the module makes
    HTMLCanvasElement.prototype.getContext = () => ({});
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb) { cb(new Blob(['png'], { type: 'image/png' })); };
  });

  it('counts pages, reading our own storage through the signed viewer', async () => {
    expect(await pdfPageCount(OWN)).toBe(3);
    expect(apiMock.viewerBlob).toHaveBeenCalledWith(OWN);
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/worker.js');
  });

  it('renders the asked page at the Nexus Sign scale and clamps the page number', async () => {
    const r = await renderPdfPage(OWN, 2);
    expect(pdfjs.doc.getPage).toHaveBeenCalledWith(2);
    expect(r.width).toBe(Math.ceil(100 * PDF_RENDER_SCALE));
    expect(r.height).toBe(Math.ceil(150 * PDF_RENDER_SCALE));
    expect(r.blob.type).toBe('image/png');
    expect(r.pages).toBe(3);
    await renderPdfPage(OWN, 99);
    expect(pdfjs.doc.getPage).toHaveBeenLastCalledWith(3);
  });

  it('reads a File directly, no fetch', async () => {
    const file = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    await renderPdfPage(file, 1);
    expect(apiMock.viewerBlob).not.toHaveBeenCalled();
  });

  it('refuses a PDF that is not in our storage, without fetching it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(pdfPageCount('https://evil.example/plan.pdf')).rejects.toThrow(/stored in Nexus/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('counts every page (the picker caps the list itself)', async () => {
    pdfjs.doc.numPages = 75;
    try { expect(await pdfPageCount(OWN)).toBe(75); } finally { pdfjs.doc.numPages = 3; }
  });
});
