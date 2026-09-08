// Task Module - "Export" for the list screens (Tasks · Projects · Portfolios ·
// Teams), as PDF or Excel.
//
// CLIENT-side on purpose. The one export that existed before this
// (Manage > Reporting > Export Excel) posts filters to the backend and streams
// an .xlsx back, which is right for "every task in the workspace with a filter
// set". These four export WHAT IS ON SCREEN - already filtered, sorted and
// searched by the person looking at it - and rebuilding that state server-side
// would mean shipping every screen's filter model to an endpoint and keeping
// the two in step forever. The rows are already in the browser; the export just
// writes them out.
//
// Both libraries are dynamically imported. They are heavy (xlsx ~400KB,
// pdf-lib ~350KB) and most sessions never export anything, so they must not sit
// in the main bundle - the module already runs close to the bundle budget that
// scripts/check-bundle-size.mjs enforces.

const stamp = () => new Date().toISOString().slice(0, 10);

// A cell is whatever the caller's `get` returned; everything lands as a string
// except numbers, which Excel should treat as numbers so a column can be summed.
const cellText = (v) => (v === null || v === undefined ? '' : String(v));

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a timer rather than immediately: Safari cancels an in-flight
  // download when the object URL disappears out from under it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rows -> .xlsx. `columns` is [{ header, get, width }]. */
export async function exportExcel({ filename, title, columns, rows }) {
  const XLSX = await import('xlsx');
  const header = columns.map((c) => c.header);
  const body = rows.map((r) => columns.map((c) => c.get(r)));
  const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  // Column widths from the caller's hint, falling back to the header's own
  // length - a sheet where every column is 8 characters wide is unreadable and
  // the first thing anyone would have to fix by hand.
  sheet['!cols'] = columns.map((c) => ({ wch: c.width || Math.max(12, c.header.length + 2) }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: columns.length - 1, r: rows.length } }) };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  const book = XLSX.utils.book_new();
  // Excel rejects sheet names over 31 chars or containing []:*?/\
  XLSX.utils.book_append_sheet(book, sheet, (title || 'Export').replace(/[[\]:*?/\\]/g, '').slice(0, 31));
  const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename || `${(title || 'export').toLowerCase().replace(/\s+/g, '-')}-${stamp()}.xlsx`);
}

// PDF geometry, in points (72 per inch). Landscape A4, because these are wide
// tables and portrait would either drop columns or shrink them past reading.
const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 32;
const ROW_H = 18;
const HEAD_H = 22;
const FONT_SIZE = 9;
const TITLE_SIZE = 14;

/** Rows -> a paginated PDF table. Same `columns` shape as exportExcel. */
export async function exportPdf({ filename, title, subtitle, columns, rows }) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Column widths: the caller's hints, scaled to exactly fill the page. Hints
  // are relative weights, so a screen does not have to know the paper size.
  const totalW = PAGE_W - MARGIN * 2;
  const weights = columns.map((c) => c.width || 14);
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * totalW);

  // Helvetica has no glyph for a lot of what lands in a task title (em dashes,
  // smart quotes, emoji). pdf-lib THROWS on those rather than dropping them, so
  // an unlucky title would fail the whole export - map the common ones and drop
  // the rest.
  const ascii = (s) => String(s ?? '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')   // NBSP as an escape: a literal one trips no-irregular-whitespace
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '');

  // Truncate to the column, with an ellipsis - wrapping would make row heights
  // variable and this a layout engine.
  const fit = (text, width, f, size) => {
    let s = ascii(text);
    if (f.widthOfTextAtSize(s, size) <= width) return s;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1);
    return `${s}...`;
  };

  let page = null;
  let y = 0;
  let pageNo = 0;

  const drawHeader = (first) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pageNo += 1;
    y = PAGE_H - MARGIN;
    if (first) {
      page.drawText(ascii(title || 'Export'), { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold, color: rgb(0.1, 0.12, 0.16) });
      if (subtitle) {
        page.drawText(ascii(subtitle), { x: MARGIN, y: y - TITLE_SIZE - 13, size: 9, font, color: rgb(0.45, 0.48, 0.53) });
      }
      y -= TITLE_SIZE + (subtitle ? 26 : 14);
    }
    // Header band
    page.drawRectangle({ x: MARGIN, y: y - HEAD_H, width: totalW, height: HEAD_H, color: rgb(0.95, 0.96, 0.97) });
    let x = MARGIN;
    columns.forEach((c, i) => {
      page.drawText(fit(c.header, widths[i] - 8, bold, FONT_SIZE), {
        x: x + 4, y: y - HEAD_H + 7, size: FONT_SIZE, font: bold, color: rgb(0.25, 0.28, 0.33),
      });
      x += widths[i];
    });
    y -= HEAD_H;
  };

  drawHeader(true);

  rows.forEach((r, ri) => {
    if (y - ROW_H < MARGIN + 16) drawHeader(false);   // repeat the header on every page
    if (ri % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: totalW, height: ROW_H, color: rgb(0.975, 0.978, 0.982) });
    }
    let x = MARGIN;
    columns.forEach((c, i) => {
      page.drawText(fit(cellText(c.get(r)), widths[i] - 8, font, FONT_SIZE), {
        x: x + 4, y: y - ROW_H + 6, size: FONT_SIZE, font, color: rgb(0.12, 0.14, 0.18),
      });
      x += widths[i];
    });
    y -= ROW_H;
  });

  // Footer on every page, added last so the page count is known.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${ascii(title || 'Export')}  -  ${rows.length} row${rows.length === 1 ? '' : 's'}  -  page ${i + 1} of ${pages.length}`, {
      x: MARGIN, y: MARGIN - 12, size: 8, font, color: rgb(0.55, 0.58, 0.63),
    });
  });

  const bytes = await doc.save();
  saveBlob(new Blob([bytes], { type: 'application/pdf' }),
    filename || `${(title || 'export').toLowerCase().replace(/\s+/g, '-')}-${stamp()}.pdf`);
}

/** One entry point, so a screen passes its rows once and the menu picks. */
export function exportRows(format, spec) {
  return format === 'pdf' ? exportPdf(spec) : exportExcel(spec);
}
