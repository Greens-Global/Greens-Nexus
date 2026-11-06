// Sheets: Import (.xlsx, .xls, .csv) and Download (.xlsx, .csv). SheetJS is
// loaded only when a file is read or written, so it stays out of first paint.
// Merges, hidden rows and columns, notes (as comments) and links go both
// ways; charts, rules and validation stay in Nexus (SheetJS cannot write them).
import { newTabSnapshot, makeCtx, buildCtx, newId, safeLink, MAX_CELLS, MAX_ROWS, MAX_COLS, DEFAULT_ROWS, DEFAULT_COLS } from './model.js';
import { encodeFormula, decodeFormula } from './formula/parse.js';
import { createEngine, isErr } from './formula/eval.js';
import { maxOf } from './formula/values.js';
import { parseInput, formatValue, serialFromDate } from './format.js';
import { mergesOf, fillTokens } from './features.js';

const TOO_BIG = 'This file has more than 500,000 cells - split it and import the parts.';
// Formulas Excel would not read the same way: Nexus variables, and arrays that spill.
const VALUE_ONLY = /\b(VAR|FILTER|SORT|UNIQUE|SEQUENCE|TRANSPOSE|SPLIT|ARRAYFORMULA|LET|TEXTBEFORE|TEXTAFTER|COUNTUNIQUE|JOIN|OFFSET|INDIRECT)\s*\(/i;

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
    Object.assign(tab, { merges: {}, hidden: {}, notes: {} });
    return { ws, tab };
  });
  const ctx = makeCtx(sheets.map((s) => s.tab), (tab, axis, n) => Array.from({ length: n }, newId));
  let count = 0;
  for (const { ws, tab } of sheets) {
    const key = (r, c) => `${ctx.rowId(tab, r)}.${ctx.colId(tab, c)}`;
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
        const link = safeLink(cell.l?.Target || '');
        if (link) out.l = link;
        const notes = Array.isArray(cell.c) ? cell.c.map((x) => String(x?.t || '')).filter(Boolean) : [];
        if (notes.length) tab.notes[key(r, c)] = { text: notes.join('\n').slice(0, 5000), by: String(cell.c[0]?.a || '').slice(0, 120) };
      }
      if (out.v == null || out.v === '') delete out.v;
      if (Object.keys(out).length) tab.cells[key(r, c)] = out;
    }
    (ws['!cols'] || []).forEach((w, i) => {
      if (i >= tab.cols.length) return;
      const px = w?.wpx || (w?.wch ? Math.round(w.wch * 7 + 5) : 0);
      if (px) tab.sizes[tab.cols[i]] = Math.max(16, Math.min(2000, px));
      if (w?.hidden) tab.hidden[tab.cols[i]] = true;
    });
    (ws['!rows'] || []).forEach((h, i) => {
      if (i >= tab.rows.length) return;
      if (h?.hpx) tab.sizes[tab.rows[i]] = Math.max(16, Math.min(2000, Math.round(h.hpx)));
      if (h?.hidden) tab.hidden[tab.rows[i]] = true;
    });
    for (const m of (ws['!merges'] || []).slice(0, 20000)) {
      if (m.e.r < tab.rows.length && m.e.c < tab.cols.length && (m.e.r > m.s.r || m.e.c > m.s.c)) {
        tab.merges[key(m.s.r, m.s.c)] = { r2: tab.rows[m.e.r], c2: tab.cols[m.e.c] };
      }
    }
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

/** Every cell a tab shows: its stored cells plus the cells arrays spill into. -> { r, c, cell, v } */
function cellsShown(ctx, eng, tab) {
  const out = [];
  const seen = new Set();
  tab.cells.forEach((cell, k) => {
    const [rid, cid] = k.split('.');
    const r = ctx.rowIndex(tab, rid), c = ctx.colIndex(tab, cid);
    if (r < 0 || c < 0 || (!cell.f && (cell.v == null || cell.v === '') && !cell.s && !cell.l)) return;
    out.push({ r, c, cell, v: eng.cellValue(tab, r, c) });
    seen.add(`${r}|${c}`);
    const sp = cell.f ? eng.spillOf(tab, r, c) : null;
    if (sp && !sp.blocked) {
      for (let i = 0; i < sp.h; i += 1) for (let j = 0; j < sp.w; j += 1) {
        if ((!i && !j) || seen.has(`${r + i}|${c + j}`) || ctx.cell(tab, r + i, c + j)) continue;
        seen.add(`${r + i}|${c + j}`);
        out.push({ r: r + i, c: c + j, cell: null, v: eng.cellValue(tab, r + i, c + j) });
      }
    }
  });
  return out;
}

/**
 * Download the workbook (.xlsx, every tab) or one tab (.csv). Variables are
 * written as their values: Excel has no VAR(), and {{tokens}} in text are
 * filled in.
 */
export async function exportSheetFile(doc, title, kind = 'xlsx', tabId = '', { variables = [], variableValues = {} } = {}) {
  const ctx = buildCtx(doc);
  const eng = createEngine(ctx, { vars: { tokens: new Set((variables || []).map((v) => v?.token).filter(Boolean)), values: variableValues || {} } });
  const text = (v) => (typeof v === 'string' ? fillTokens(v, variableValues)?.text ?? v : v);
  if (kind === 'csv') {
    const tab = ctx.tabById(tabId) || ctx.tabs[0];
    const all = cellsShown(ctx, eng, tab);
    const maxR = maxOf(all.map((x) => x.r), -1), maxC = maxOf(all.map((x) => x.c), -1);
    const grid = Array.from({ length: maxR + 1 }, () => Array(maxC + 1).fill(''));
    for (const x of all) {
      const t = text(formatValue(x.v, x.cell?.s));
      // A text cell that starts like a formula is written so a spreadsheet opening the file reads it as text.
      grid[x.r][x.c] = typeof x.v === 'string' && /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    }
    const csv = grid.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
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
  for (const xt of xlTabs) {
    const tab = ctx.tabById(xt.id);
    const ws = {};
    let maxR = 0, maxC = 0;
    for (const { r, c, cell, v } of cellsShown(ctx, eng, tab)) {
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
      const val = text(v);
      const out = isErr(val) ? { t: 'e', v: XL_ERR[val.code] ?? 15, w: val.code }
        : typeof val === 'number' ? { t: 'n', v: val } : typeof val === 'boolean' ? { t: 'b', v: val } : { t: 's', v: val == null ? '' : String(val) };
      // A formula that spills (=A1:A9*2) is a dynamic array Excel would need marked as one: its values go instead.
      if (cell?.f && !VALUE_ONLY.test(cell.f) && !eng.spillOf(tab, r, c)) out.f = decodeFormula(cell.f, xlCtx, tab.id).slice(1);
      const z = xlFormat(cell?.s);
      if (z) out.z = z;
      if (cell?.l) out.l = { Target: cell.l };
      const note = tab.notes?.get(`${tab.rows[r]}.${tab.cols[c]}`);
      if (note) out.c = [{ a: note.by || 'Nexus', t: note.text }];
      ws[XLSX.utils.encode_cell({ r, c })] = out;
    }
    tab.notes?.forEach((note, k) => {
      const [rid, cid] = k.split('.');
      const r = ctx.rowIndex(tab, rid), c = ctx.colIndex(tab, cid);
      const addr = r >= 0 && c >= 0 ? XLSX.utils.encode_cell({ r, c }) : '';
      if (addr && !ws[addr]) { ws[addr] = { t: 's', v: '', c: [{ a: note.by || 'Nexus', t: note.text }] }; maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    ws['!cols'] = tab.cols.slice(0, maxC + 1).map((id) => ({ wpx: ctx.size(tab, id, 100), ...(tab.hidden?.has(id) ? { hidden: true } : {}) }));
    ws['!rows'] = tab.rows.slice(0, maxR + 1).map((id) => (tab.hidden?.has(id) ? { hidden: true } : {}));
    const merges = mergesOf(ctx, tab);
    if (merges.length) ws['!merges'] = merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
    if (tab.frozenRows || tab.frozenCols) ws['!freeze'] = { xSplit: tab.frozenCols, ySplit: tab.frozenRows };
    XLSX.utils.book_append_sheet(wb, ws, xt.name);
  }
  // Named ranges, so formulas that use them still work in Excel.
  const names = [];
  ctx.names.forEach((n) => {
    const at = ctx.nameRef(n.name);
    const xt = at && xlTabs.find((t) => t.id === at.tab.id);
    if (!xt) return;
    const sheet = `'${xt.name.replace(/'/g, "''")}'`;
    const abs = (r, c) => `$${XLSX.utils.encode_col(c)}$${r + 1}`;
    names.push({ Name: n.name, Ref: `${sheet}!${abs(at.r1, at.c1)}:${abs(at.r2, at.c2)}` });
  });
  if (names.length) wb.Workbook = { ...(wb.Workbook || {}), Names: names };
  XLSX.writeFile(wb, `${fileName(title)}.xlsx`, { compression: true });
}
