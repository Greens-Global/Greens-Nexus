// Sheets: Import (.xlsx, .xls, .csv) and Download (.xlsx, .csv). SheetJS is
// loaded only when a file is read or written, so it stays out of first paint.
import { newTabSnapshot, makeCtx, buildCtx, newId, MAX_CELLS, MAX_ROWS, MAX_COLS, DEFAULT_ROWS, DEFAULT_COLS } from './model.js';
import { encodeFormula, decodeFormula } from './formula/parse.js';
import { createEngine, isErr } from './formula/eval.js';
import { parseInput, formatValue, serialFromDate } from './format.js';

const TOO_BIG = 'This file has more than 500,000 cells - split it and import the parts.';

/** An Excel number format -> ours. */
function nfFrom(z) {
  if (!z || z === 'General') return null;
  const dec = (z.match(/\.(0+)/)?.[1] || '').length;
  if (z === '@') return { nf: 'text' };
  if (/%/.test(z)) return { nf: 'percent', d: dec };
  if (/\$/.test(z)) return { nf: 'currency', d: dec };
  const date = /[dy]/i.test(z) || /m{3,}/i.test(z), time = /h/i.test(z) || /AM\/PM/i.test(z);
  if (date && time) return { nf: 'datetime' };
  if (date || /^m+\/d+/i.test(z)) return { nf: 'date' };
  if (time) return { nf: 'time' };
  if (/0/.test(z)) return { nf: 'number', d: dec };
  return null;
}

/** A spreadsheet file -> a workbook snapshot (fresh tab, row and column ids). */
export async function importSheetFile(file) {
  const XLSX = await import('xlsx');
  const csv = /\.csv$/i.test(file.name || '') || file.type === 'text/csv';
  const wb = csv
    ? XLSX.read(await file.text(), { type: 'string', raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: true, cellStyles: true, cellNF: true, cellDates: false });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { e: { r: 0, c: 0 } };
    if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLS) throw new Error(`"${name}" is larger than 200,000 rows or 2,000 columns - trim it and import again.`);
    const tab = newTabSnapshot(String(name).slice(0, 100) || 'Sheet', Math.max(range.e.r + 1, DEFAULT_ROWS), Math.max(range.e.c + 1, DEFAULT_COLS));
    return { ws, tab };
  });
  const ctx = makeCtx(sheets.map((s) => s.tab), (tab, axis, n) => Array.from({ length: n }, newId));
  let count = 0;
  for (const { ws, tab } of sheets) {
    for (const [addr, cell] of Object.entries(ws)) {
      if (addr[0] === '!' || !cell) continue;
      if ((count += 1) > MAX_CELLS) throw new Error(TOO_BIG);
      const { r, c } = XLSX.utils.decode_cell(addr);
      const out = {};
      if (cell.f) {
        try { out.f = encodeFormula('=' + cell.f, ctx, tab.id); } catch { out.v = String(cell.w ?? cell.v ?? ''); }
      } else if (csv) {
        const p = parseInput(cell.v);
        if (p.f) { try { out.f = encodeFormula(p.f, ctx, tab.id); } catch { out.v = p.f; } } else out.v = p.v;
        if (p.nf) out.s = { nf: p.nf, ...(p.d != null ? { d: p.d } : {}) };
      } else if (cell.t === 'n') out.v = Number.isFinite(cell.v) ? cell.v : null;
      else if (cell.t === 'b') out.v = !!cell.v;
      else if (cell.t === 'd') out.v = serialFromDate(cell.v);
      else if (cell.t === 'e') out.v = String(cell.w || '#N/A');
      else out.v = String(cell.v ?? '').slice(0, 50000);
      if (!csv) {
        const s = {};
        const fmt = nfFrom(cell.z);
        if (fmt) Object.assign(s, fmt);
        const font = cell.s?.font;
        if (font?.bold) s.b = true;
        if (font?.italic) s.i = true;
        if (font?.underline) s.u = true;
        if (Object.keys(s).length) out.s = s;
      }
      if (out.v == null || out.v === '') delete out.v;
      if (Object.keys(out).length) tab.cells[`${ctx.rowId(tab, r)}.${ctx.colId(tab, c)}`] = out;
    }
    (ws['!cols'] || []).forEach((w, i) => {
      const px = w?.wpx || (w?.wch ? Math.round(w.wch * 7 + 5) : 0);
      if (px && i < tab.cols.length) tab.sizes[tab.cols[i]] = Math.max(16, Math.min(2000, px));
    });
    (ws['!rows'] || []).forEach((h, i) => {
      if (h?.hpx && i < tab.rows.length) tab.sizes[tab.rows[i]] = Math.max(16, Math.min(2000, Math.round(h.hpx)));
    });
  }
  return { type: 'nexus-sheet', v: 1, tabs: sheets.map((s) => s.tab) };
}

const XL_ERR = { '#NULL!': 0, '#DIV/0!': 7, '#VALUE!': 15, '#REF!': 23, '#NAME?': 29, '#NUM!': 36, '#N/A': 42 };
function xlFormat(s) {
  const d = Number.isInteger(s?.d) ? s.d : 2;
  const dec = d ? '.' + '0'.repeat(d) : '';
  switch (s?.nf) {
    case 'number': return `#,##0${dec}`;
    case 'currency': return `"$"#,##0${dec}`;
    case 'percent': return `0${Number.isInteger(s?.d) ? dec : '.00'}%`;
    case 'date': return 'mm/dd/yyyy';
    case 'time': return 'h:mm AM/PM';
    case 'datetime': return 'mm/dd/yyyy h:mm AM/PM';
    case 'text': return '@';
    default: return undefined;
  }
}
const fileName = (title) => (String(title || 'Sheet').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Sheet');

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the workbook (.xlsx, every tab) or one tab (.csv). */
export async function exportSheetFile(doc, title, kind = 'xlsx', tabId = '') {
  const ctx = buildCtx(doc);
  const eng = createEngine(ctx);
  if (kind === 'csv') {
    const tab = ctx.tabById(tabId) || ctx.tabs[0];
    let maxR = -1, maxC = -1;
    tab.cells.forEach((_, k) => {
      const [rid, cid] = k.split('.');
      maxR = Math.max(maxR, ctx.rowIndex(tab, rid)); maxC = Math.max(maxC, ctx.colIndex(tab, cid));
    });
    const rows = [];
    for (let r = 0; r <= maxR; r += 1) {
      const row = [];
      for (let c = 0; c <= maxC; c += 1) {
        const cell = ctx.cell(tab, r, c);
        row.push(cell ? formatValue(eng.cellValue(tab, r, c), cell.s) : '');
      }
      rows.push(row);
    }
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileName(title)}.csv`);
    return;
  }
  const XLSX = await import('xlsx');
  // Excel tab names: 31 characters, none of []:*?/\ - and formulas say them.
  const used = new Set();
  const xlTabs = ctx.tabs.map((t) => {
    let n = t.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
    for (let k = 2; used.has(n.toLowerCase()); k += 1) n = `${n.slice(0, 27)} ${k}`;
    used.add(n.toLowerCase());
    return { ...t, name: n };
  });
  const xlCtx = makeCtx(xlTabs);
  const wb = XLSX.utils.book_new();
  for (const tab of xlTabs) {
    const ws = {};
    let maxR = 0, maxC = 0;
    tab.cells.forEach((cell, k) => {
      const [rid, cid] = k.split('.');
      const r = ctx.rowIndex(tab, rid), c = ctx.colIndex(tab, cid);
      if (r < 0 || c < 0) return;
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
      const v = cell.f ? eng.cellValue(ctx.tabById(tab.id), r, c) : cell.v;
      const out = isErr(v) ? { t: 'e', v: XL_ERR[v.code] ?? 15, w: v.code }
        : typeof v === 'number' ? { t: 'n', v } : typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v: v == null ? '' : String(v) };
      if (cell.f) out.f = decodeFormula(cell.f, xlCtx, tab.id).slice(1);
      const z = xlFormat(cell.s);
      if (z) out.z = z;
      ws[XLSX.utils.encode_cell({ r, c })] = out;
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    ws['!cols'] = tab.cols.slice(0, maxC + 1).map((id) => ({ wpx: ctx.size(tab, id, 100) }));
    if (tab.frozenRows || tab.frozenCols) ws['!freeze'] = { xSplit: tab.frozenCols, ySplit: tab.frozenRows };
    XLSX.utils.book_append_sheet(wb, ws, tab.name);
  }
  XLSX.writeFile(wb, `${fileName(title)}.xlsx`, { compression: true });
}
