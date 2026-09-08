import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportExcel, exportPdf } from './exporting';

// Export as PDF / Excel from the four list screens. These actually RUN the
// generators - the failure they exist for is pdf-lib throwing partway through a
// document, which no amount of rendering the button would catch.
//
// The specific trap: pdf-lib's standard fonts are WinAnsi, and drawText THROWS
// on any character outside it rather than dropping it. Real task titles are
// full of em dashes, smart quotes and the odd emoji, so an unescaped one would
// fail the whole export - for the one person whose task happened to contain it.

const captured = [];

// jsdom's Blob has no arrayBuffer(), so the bytes are captured as they go IN
// rather than read back out.
const RealBlob = globalThis.Blob;
class CapturingBlob extends RealBlob {
  constructor(parts, opts) { super(parts, opts); this.parts = parts; }
}

beforeEach(() => {
  captured.length = 0;
  globalThis.Blob = CapturingBlob;
  // jsdom has no object-URL plumbing and no real downloads; capture the blob
  // the module hands to the anchor instead.
  globalThis.URL.createObjectURL = vi.fn((blob) => { captured.push(blob); return 'blob:test'; });
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

const columns = [
  { header: 'Task', width: 30, get: (r) => r.title },
  { header: 'Status', width: 12, get: (r) => r.status },
  { header: 'Count', width: 8, get: (r) => r.count },
];
const rows = [
  { title: 'Backup - QuickBooks Files', status: 'Not Started', count: 3 },
  { title: 'EOM Report', status: 'In Progress', count: 12 },
];

const bytesOf = (blob) => {
  const part = blob.parts[0];
  return part instanceof Uint8Array ? part : new Uint8Array(part);
};

describe('Excel export', () => {
  it('writes a real xlsx workbook', async () => {
    await exportExcel({ title: 'Tasks', columns, rows, filename: 'tasks.xlsx' });
    expect(captured).toHaveLength(1);
    const head = bytesOf(captured[0]);
    // xlsx is a zip: "PK\x03\x04".
    expect([head[0], head[1], head[2], head[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(head.length).toBeGreaterThan(500);
  });

  it('survives a sheet name Excel would reject', async () => {
    // Over 31 chars AND containing / and : - both are hard errors in Excel.
    await exportExcel({ title: 'Tasks / Portfolios: a very long name indeed', columns, rows });
    expect(captured).toHaveLength(1);
  });
});

describe('PDF export', () => {
  it('writes a real pdf', async () => {
    await exportPdf({ title: 'Tasks', subtitle: '2 tasks', columns, rows });
    const head = bytesOf(captured[0]);
    expect(String.fromCharCode(...head.slice(0, 5))).toBe('%PDF-');
  });

  it('does not throw on characters the standard font cannot encode', async () => {
    const nasty = [
      { title: 'Rename “Punch In” — and the ellipsis…', status: 'Done', count: 1 },
      { title: 'Emoji 🚀 and a nbsp gap', status: 'Done', count: 2 },
      { title: "Smart ’quotes’ everywhere", status: 'Done', count: 3 },
    ];
    await expect(exportPdf({ title: 'Tasks', columns, rows: nasty })).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
  });

  it('paginates rather than running off the page', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ title: `Task ${i}`, status: 'Open', count: i }));
    await exportPdf({ title: 'Tasks', columns, rows: many });
    // Read the document back with pdf-lib rather than grepping the bytes: the
    // object streams are compressed, so "/Type /Page" is not in the plain text,
    // and parsing it also proves the file is genuinely well-formed.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytesOf(captured[0]));
    expect(doc.getPageCount()).toBeGreaterThan(1);
    // 120 rows at ~25 per landscape page - a single page would mean the rows
    // ran off the bottom instead of wrapping to a new one.
    expect(doc.getPageCount()).toBeLessThan(12);
  });

  it('handles an empty row set without producing a broken file', async () => {
    await exportPdf({ title: 'Tasks', columns, rows: [] });
    const head = bytesOf(captured[0]);
    expect(String.fromCharCode(...head.slice(0, 5))).toBe('%PDF-');
  });
});
