import JSZip from 'jszip';
import { bookLabel, canPickBook, entityText, periodText } from './reportModel';

// A statement as an Excel workbook (Neil, 09/29 call, "critical"): the totals
// stand out, every column is as wide as what is in it, and the totals are
// LIVE formulas - a controller who changes a figure sees the total move, the
// way a workbook built by hand would.
//
// Written here from the same result the screen draws (runReport), as the
// .xlsx file format itself (a zip of XML sheets), because the spreadsheet
// library in the bundle cannot write bold or fills. Everything a reader needs
// is in the six small files below; Excel, Numbers and Google Sheets open it.
//
// Sheet layout: title, then the entity / period / book line, a blank row, a
// header row (frozen), then the statement. Each section lists its accounts
// and ends on a "Total <Section>" row whose figures are SUM() over the
// accounts above; the subtotals below (Gross Profit, Operating Income, Net
// Income, Total Liabilities and Equity) are formulas over those totals; a
// Total column across months or entities is a SUM() across the row; a
// comparison's variance columns are formulas too.

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (n) => { let s = ''; let x = n; while (x >= 0) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } return s; };
const ref = (c, r) => `${colName(c)}${r}`;

// Cell styles, by index (see STYLES_XML): what each kind of cell looks like.
const S = { text: 0, bold: 1, title: 2, muted: 3, num: 4, numTotal: 5, numGrand: 6, header: 7, headerNum: 8, pct: 9, pctTotal: 10, sectionText: 11, sectionNum: 12, date: 13, dateHeader: 8 };

const NUM_FMT = '#,##0.00;(#,##0.00);"-"';
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="${esc(NUM_FMT)}"/><numFmt numFmtId="165" formatCode="0.0%;(0.0%);&quot;-&quot;"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF3C4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECFD"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="4">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="double"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="medium"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// One cell for the sheet XML. `f` = formula (without the "="), `v` = the
// cached value so a reader that does not calculate still shows a figure.
function cell(c, r, { text, num, f, s = S.text }) {
  const at = ref(c, r);
  if (f !== undefined) return `<c r="${at}" s="${s}"><f>${esc(f)}</f>${Number.isFinite(num) ? `<v>${num}</v>` : ''}</c>`;
  if (text !== undefined) return text === '' ? '' : `<c r="${at}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  if (Number.isFinite(num)) return `<c r="${at}" s="${s}"><v>${num}</v></c>`;
  return '';
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Lay a runReport() result out as sheet rows. Returns { rows, widths } where
 * rows = [[cellSpec...]], each spec { text | num | f, s, len } (len = the
 * printed length, for the column widths).
 */
export function statementCells({ title, result, entities = [] }) {
  const { config, def, columns } = result;
  const dataCols = columns.map((c, i) => ({ ...c, i })).filter((c) => c.type === 'amount' && !c.emphasis);
  const totalCol = columns.findIndex((c) => c.type === 'amount' && c.emphasis);
  const varCol = columns.findIndex((c) => c.type === 'variance');
  const pctCol = columns.findIndex((c) => c.type === 'pct');
  const dateCols = columns.map((c, i) => (c.type === 'date' ? i : -1)).filter((i) => i >= 0);
  const textCols = columns.map((c, i) => (c.type === 'text' ? i : -1)).filter((i) => i >= 0);
  // Sheet columns: A = account code, B = title, then one per statement column.
  const FIRST = 2;
  const sheetCol = (i) => FIRST + i;
  const rows = [];
  const push = (cells) => { rows.push(cells); return rows.length; };   // 1-based row number

  const sub = [entityText(config, entities), periodText(config), canPickBook(config) ? `Book: ${bookLabel(config.book)}` : ''].filter(Boolean).join('  ·  ');
  push([{ text: title || def.label, s: S.title }]);
  push([{ text: `${result.org ? `${result.org}  ·  ` : ''}${sub}`, s: S.muted }]);
  push([]);
  const header = [{ text: result.glLabel ? 'Date' : 'Account', s: S.header }, { text: result.glLabel ? 'Account' : 'Title', s: S.header }];
  columns.forEach((c, i) => { header[sheetCol(i)] = { text: c.label, s: c.type === 'date' || c.type === 'text' ? S.header : S.headerNum }; });
  const headerRow = push(header);

  // The figure cells of one row: numbers in the data columns, formulas in the
  // derived ones. `numsAt(i)` = the cached number for statement column i.
  const derived = (rowNo, numsAt, total, isPct) => {
    const out = {};
    if (totalCol >= 0) {
      const parts = dataCols.map((c) => ref(sheetCol(c.i), rowNo));
      out[totalCol] = { f: `SUM(${parts.join(',')})`, num: numsAt(totalCol), s: total ? S.numTotal : S.num };
    }
    if (varCol >= 0 && dataCols.length >= 2) {
      const a = ref(sheetCol(dataCols[0].i), rowNo);
      const b = ref(sheetCol(dataCols[1].i), rowNo);
      out[varCol] = { f: `${a}-${b}`, num: numsAt(varCol), s: total ? S.numTotal : S.num };
      if (pctCol >= 0) out[pctCol] = { f: `IF(${b}=0,"",(${a}-${b})/ABS(${b}))`, num: isPct ? undefined : parsePct(numsAt(pctCol)), s: total ? S.pctTotal : S.pct };
    }
    return out;
  };
  const parsePct = (v) => { if (typeof v !== 'string' || !v) return undefined; const n = Number(v.replace(/[()%,]/g, '')) / 100; return Number.isFinite(n) ? (v.startsWith('(') ? -n : n) : undefined; };

  // Figures for a plain row (account, or a total whose parts are not on the sheet).
  const figures = (rowNo, values, { total = false, grand = false } = {}) => {
    const cells = [];
    const numsAt = (i) => (typeof values[i] === 'number' ? round2(values[i]) : values[i]);
    dataCols.forEach((c) => { cells[sheetCol(c.i)] = { num: round2(values[c.i]), s: grand ? S.numGrand : total ? S.numTotal : S.num }; });
    dateCols.forEach((i) => { cells[sheetCol(i)] = { text: values[i] || '', s: S.date }; });
    textCols.forEach((i) => { cells[sheetCol(i)] = { text: values[i] == null ? '' : String(values[i]), s: S.text }; });
    Object.entries(derived(rowNo, numsAt, total)).forEach(([i, spec]) => { cells[sheetCol(Number(i))] = grand ? { ...spec, s: spec.s === S.pctTotal ? S.pctTotal : S.numGrand } : spec; });
    return cells;
  };
  // A total row whose data columns are formulas over other rows.
  const formulaRow = (rowNo, label, values, exprOf, { grand = false, pct = false } = {}) => {
    const cells = [{ text: label, s: S.bold }, { text: '', s: S.bold }];
    const numsAt = (i) => (typeof values[i] === 'number' ? round2(values[i]) : values[i]);
    dataCols.forEach((c) => {
      const col = sheetCol(c.i);
      const f = exprOf(col);
      cells[col] = f ? { f, num: pct ? undefined : round2(values[c.i]), s: pct ? S.pctTotal : grand ? S.numGrand : S.numTotal } : { num: round2(values[c.i]), s: grand ? S.numGrand : S.numTotal };
    });
    if (!pct) Object.entries(derived(rowNo, numsAt, true)).forEach(([i, spec]) => { cells[sheetCol(Number(i))] = grand && spec.s === S.numTotal ? { ...spec, s: S.numGrand } : spec; });
    else if (totalCol >= 0) {
      const f = exprOf(sheetCol(totalCol));
      cells[sheetCol(totalCol)] = f ? { f, s: S.pctTotal } : { text: '' };
    }
    return cells;
  };

  // Walk the statement. Sections: heading row, accounts, then "Total <Section>".
  const sectionTotalRow = {};     // section key -> row number of its total
  const sectionRange = {};        // section key -> [first account row, last]
  let open = null;
  const closeSection = () => {
    if (!open) return;
    const rowNo = rows.length + 1;
    const [a, b] = sectionRange[open.section] || [];
    const cells = formulaRow(rowNo, `Total ${open.label}`, open.values, (col) => (a ? `SUM(${ref(col, a)}:${ref(col, b)})` : null));
    push(cells);
    sectionTotalRow[open.section] = rowNo;
    open = null;
  };
  const totalRef = (key, col) => (sectionTotalRow[key] ? ref(col, sectionTotalRow[key]) : null);
  const plus = (parts) => { const p = parts.filter(Boolean); return p.length ? p.join('+') : null; };
  const minus = (a, b) => (a && b ? `${a}-(${b})` : a || (b ? `-(${b})` : null));
  const subtotalRow = {};         // label -> row number, for the subtotals that build on each other

  result.rows.forEach((r) => {
    // A General Ledger account group (Bank, Credit Card, ...): its heading
    // here, its "Total <group>" row after its accounts (Oct 7, item 22).
    if (r.kind === 'group') {
      closeSection();
      const cells = [{ text: r.label, s: S.sectionText }, { text: '', s: S.sectionText }];
      columns.forEach((_c, i) => { cells[sheetCol(i)] = { text: '', s: S.sectionText }; });
      push(cells);
      return;
    }
    if (r.kind === 'section') {
      closeSection();
      // A General Ledger account heading carries its opening balance; a
      // statement section is a heading only, its total follows its accounts.
      if (result.glLabel) {
        const rowNo = rows.length + 1;
        const cells = [{ text: r.label, s: S.sectionText }, { text: '', s: S.sectionText }];
        columns.forEach((c, i) => { cells[sheetCol(i)] = c.type === 'amount' ? { num: round2(r.values[i]), s: S.sectionNum } : { text: r.values[i] || '', s: S.sectionText }; });
        push(cells);
        return;
      }
      open = r;
      const cells = [{ text: r.label, s: S.sectionText }, { text: '', s: S.sectionText }];
      columns.forEach((_c, i) => { cells[sheetCol(i)] = { text: '', s: S.sectionText }; });
      push(cells);
      return;
    }
    if (r.kind === 'line') {
      const rowNo = rows.length + 1;
      const cells = [];
      Object.assign(cells, figures(rowNo, r.values));
      cells[0] = { text: r.label || '', s: S.muted };
      cells[1] = { text: '', s: S.text };
      push(cells);
      if (r.section) { const cur = sectionRange[r.section]; sectionRange[r.section] = cur ? [cur[0], rowNo] : [rowNo, rowNo]; }
      return;
    }
    if (r.kind === 'account') {
      const rowNo = rows.length + 1;
      const cells = [{ text: r.code || '', s: S.muted }, { text: r.title || '', s: S.text }, ...[]];
      Object.assign(cells, figures(rowNo, r.values));
      cells[0] = { text: r.code || '', s: S.muted };
      cells[1] = { text: r.title || '', s: S.text };
      push(cells);
      if (r.section) { const cur = sectionRange[r.section]; sectionRange[r.section] = cur ? [cur[0], rowNo] : [rowNo, rowNo]; }
      return;
    }
    closeSection();
    const rowNo = rows.length + 1;
    const rev = (col) => totalRef('revenue', col);
    const cogs = (col) => totalRef('cogs', col);
    const opex = (col) => totalRef('expense', col);
    const oi = (col) => totalRef('other_income', col);
    const oe = (col) => totalRef('other_expense', col);
    const at = (label, col) => (subtotalRow[label] ? ref(col, subtotalRow[label]) : null);
    let cells;
    if (def.key === 'pnl' && r.label === 'Gross Profit') cells = formulaRow(rowNo, r.label, r.values, (col) => minus(rev(col), cogs(col)));
    else if (def.key === 'pnl' && r.label === 'Operating Income') cells = formulaRow(rowNo, r.label, r.values, (col) => minus(at('Gross Profit', col), opex(col)));
    else if (def.key === 'pnl' && r.label === 'Net Income') cells = formulaRow(rowNo, r.label, r.values, (col) => minus(plus([at('Operating Income', col), oi(col)]), oe(col)), { grand: true });
    else if (def.key === 'pnl' && r.kind === 'margin') {
      cells = formulaRow(rowNo, r.label, r.values, (col) => {
        const income = plus([rev(col), oi(col)]);
        const net = at('Net Income', col);
        return income && net ? `IF((${income})=0,"",${net}/(${income}))` : null;
      }, { pct: true });
    } else if (def.key === 'balance-sheet' && r.label === 'Total Liabilities and Equity') cells = formulaRow(rowNo, r.label, r.values, (col) => plus([totalRef('liability', col), totalRef('equity', col)]), { grand: true });
    else if (def.key === 'balance-sheet' && r.kind === 'warn') cells = formulaRow(rowNo, r.label, r.values, (col) => minus(totalRef('asset', col), at('Total Liabilities and Equity', col)));
    else if (r.kind === 'grand' && (def.key === 'trial-balance' || def.key === 'cash-position')) {
      // Every account row sits between the header and here.
      const first = headerRow + 1;
      cells = formulaRow(rowNo, r.label, r.values, (col) => (rowNo - 1 >= first ? `SUM(${ref(col, first)}:${ref(col, rowNo - 1)})` : null), { grand: true });
    } else {
      cells = [{ text: r.label, s: S.bold }, { text: '', s: S.bold }];
      Object.assign(cells, figures(rowNo, r.values, { total: true, grand: r.kind === 'grand' }));
      cells[0] = { text: r.label, s: S.bold };
      cells[1] = { text: '', s: S.bold };
    }
    push(cells);
    subtotalRow[r.label] = rowNo;
  });
  closeSection();

  // Column widths from the longest printed value, in characters.
  const widths = [];
  const printed = (spec) => (spec?.text !== undefined ? spec.text : Number.isFinite(spec?.num) ? spec.num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : spec?.f ? '0,000,000.00' : '');
  rows.forEach((cells, rIdx) => {
    if (rIdx < 2) return;   // the title lines span the sheet; they do not size a column
    cells.forEach((spec, c) => { if (spec) widths[c] = Math.max(widths[c] || 0, String(printed(spec)).length); });
  });
  return { rows, widths: widths.map((w, i) => Math.min(60, Math.max(i === 1 ? 24 : 10, Math.round((w || 0) * 1.1 + 3)))), headerRow };
}

function sheetXml({ rows, widths, headerRow }) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((cells, rIdx) => {
    const r = rIdx + 1;
    const xml = cells.map((spec, c) => (spec ? cell(c, r, spec) : '')).join('');
    return `<row r="${r}">${xml}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${body}</sheetData>
<pageSetup orientation="${widths.length > 6 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

/** The workbook bytes (Uint8Array) for one statement. */
export async function buildStatementWorkbook({ title, result, entities = [] }) {
  const laid = statementCells({ title, result, entities });
  const sheetName = (result.def?.label || 'Statement').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title || result.def?.label || 'Statement')}</dc:title><dc:creator>Greens Nexus</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Greens Nexus</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/styles.xml', STYLES_XML);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(laid));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
