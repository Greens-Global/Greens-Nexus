import JSZip from 'jszip';

// Ledger lines (a search, or a report's drill-down) as a file - Charmi, 10/02:
// "it should just utilize the top one and take the data from the bottom.
// Those export options should be available at all places." The report's own
// Export menu takes the lines on screen and offers the same PDF / Excel / CSV
// (and Email, Save to Files) it offers for a statement.
//
// table: {
//   title     'Ledger Lines - 11101 Chase Checking'
//   subtitle  'All entities · 01/01/2026 - 10/02/2026 · accrual book'
//   columns   [{ label, num, width }]   num: an amount column; width: the on-screen px
//   rows      [[cell, ...]]             amounts as numbers, the rest as text
//   totals    [cell, ...] | null        the Totals line (text in the first cell)
// }

const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
export const EXT = { pdf: 'pdf', excel: 'xlsx', csv: 'csv' };

export function linesBaseName(table) {
  return safe(`${table.title}${table.period ? ` - ${table.period}` : ''}`).slice(0, 150) || 'Ledger Lines';
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function linesCsv(table) {
  const out = [table.columns.map((c) => c.label), ...table.rows];
  if (table.totals) out.push(table.totals);
  return String.fromCharCode(0xfeff) + out.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ── Excel ───────────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (n) => { let s = ''; let x = n; while (x >= 0) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } return s; };
// 0 text, 1 bold, 2 title, 3 muted, 4 amount, 5 bold amount, 6 header, 7 header amount
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00);&quot;&quot;"/></numFmts>
<fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="double"/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
</styleSheet>`;

function sheetXml(table) {
  const lines = [];
  const cell = (c, r, v, style, num) => {
    const at = `${colName(c)}${r}`;
    if (num && typeof v === 'number' && Number.isFinite(v)) return `<c r="${at}" s="${style}"><v>${v}</v></c>`;
    if (v == null || v === '') return style ? `<c r="${at}" s="${style}"/>` : '';
    return `<c r="${at}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  let r = 1;
  lines.push(`<row r="${r}">${cell(0, r, table.title, 2)}</row>`); r += 1;
  if (table.subtitle) { lines.push(`<row r="${r}">${cell(0, r, table.subtitle, 3)}</row>`); r += 1; }
  r += 1;
  const headRow = r;
  lines.push(`<row r="${r}">${table.columns.map((c, i) => cell(i, r, c.label, c.num ? 7 : 6)).join('')}</row>`); r += 1;
  const first = r;
  table.rows.forEach((row) => {
    lines.push(`<row r="${r}">${table.columns.map((c, i) => cell(i, r, row[i], c.num ? 4 : 0, c.num)).join('')}</row>`);
    r += 1;
  });
  if (table.totals) {
    const last = r - 1;
    lines.push(`<row r="${r}">${table.columns.map((c, i) => {
      // Totals are live sums over the lines above, like the statements' workbooks.
      if (c.num && last >= first) return `<c r="${colName(i)}${r}" s="5"><f>SUBTOTAL(9,${colName(i)}${first}:${colName(i)}${last})</f></c>`;
      return cell(i, r, table.totals[i], c.num ? 5 : 1, c.num);
    }).join('')}</row>`);
  }
  const widths = table.columns.map((c, i) => {
    const longest = Math.max(String(c.label).length, ...table.rows.slice(0, 2000).map((row) => String(c.num && typeof row[i] === 'number' ? row[i].toFixed(2) : row[i] ?? '').length));
    return Math.min(60, Math.max(8, longest + 2));
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${lines.join('')}</sheetData>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

export async function linesWorkbook(table) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Ledger Lines" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(table));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ── PDF ─────────────────────────────────────────────────────────────────────
// Landscape letter, the columns in their on-screen proportions, banded rows,
// the heading repeated on every page, page numbers at the foot.
export async function linesPdf(table) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { INK, MUTED, RULE, BAND, clean, fit } = await import('./reportPdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(clean(table.title));
  doc.setCreator('Greens Nexus');
  const W = 792; const H = 612; const M = 36; const SIZE = 7.5; const ROW = 12;
  const total = table.columns.reduce((n, c) => n + (c.width || 120), 0);
  const widths = table.columns.map((c) => ((c.width || 120) / total) * (W - 2 * M));
  const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
  const money = (v) => (typeof v === 'number' && Math.abs(v) >= 0.005 ? (v < 0 ? `(${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : '');
  const pages = [];
  let page; let y;
  const put = (text, i, yy, f, color = INK) => {
    const c = table.columns[i];
    const t = fit(f, SIZE, c.num ? money(text) : text ?? '', widths[i] - 6);
    const x = c.num ? xs[i] + widths[i] - 3 - f.widthOfTextAtSize(t, SIZE) : xs[i] + 3;
    page.drawText(t, { x, y: yy, size: SIZE, font: f, color });
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - M;
    page.drawText(fit(bold, 12, table.title, W - 2 * M), { x: M, y: y - 10, size: 12, font: bold, color: INK });
    y -= 24;
    if (table.subtitle) { page.drawText(fit(font, 8.5, table.subtitle, W - 2 * M), { x: M, y, size: 8.5, font, color: MUTED }); y -= 16; }
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: ROW + 2, color: BAND });
    table.columns.forEach((c, i) => put(c.label, i, y, bold, MUTED));
    // A header label is text even over an amount column.
    y -= ROW + 4;
  };
  newPage();
  table.rows.forEach((row, n) => {
    if (y < M + 20) newPage();
    if (n % 2 === 1) page.drawRectangle({ x: M, y: y - 3, width: W - 2 * M, height: ROW, color: BAND });
    row.forEach((v, i) => put(v, i, y, font));
    y -= ROW;
  });
  if (table.totals) {
    if (y < M + 20) newPage();
    page.drawLine({ start: { x: M, y: y + ROW - 2 }, end: { x: W - M, y: y + ROW - 2 }, thickness: 0.8, color: RULE });
    table.totals.forEach((v, i) => put(v, i, y, bold));
  }
  pages.forEach((p, i) => {
    const t = `Page ${i + 1} of ${pages.length}`;
    p.drawText(t, { x: W - M - font.widthOfTextAtSize(t, 7.5), y: M - 18, size: 7.5, font, color: MUTED });
    p.drawText('Greens Nexus - from the Nexus Accounting ledger', { x: M, y: M - 18, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}

/** The lines as a File, named `name` (with its extension) or after the table. */
export async function linesFile(table, format, name) {
  const fileName = name || `${linesBaseName(table)}.${EXT[format] || 'pdf'}`;
  if (format === 'csv') return new File([linesCsv(table)], fileName, { type: 'text/csv;charset=utf-8' });
  if (format === 'excel') return new File([await linesWorkbook(table)], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return new File([await linesPdf(table)], fileName, { type: 'application/pdf' });
}
