// Sheets: pivot tables (Google Sheets style). A pivot is stored on the tab it
// is drawn on (extras 'pivots'): its source range by stable row / column ids
// (and the source tab's id), the cell it starts at, and its Rows, Columns,
// Values and Filters by source column id - so inserting or deleting rows and
// columns, by anyone, keeps it pointing at the same data.
//
// The output is worked out by the formula engine (eval.js asks computePivot)
// and drawn like a spill: read-only values in empty cells, or #REF! at its
// corner when something is in the way. It recalculates with every change.
import { formatValue, usDate, ymdFromSerial } from './format.js';
import { isErr, compare } from './formula/values.js';

export const SOURCE_BUDGET = 200000;   // source cells one pivot reads
export const OUTPUT_BUDGET = 100000;   // cells one pivot draws
export const BLANK = '(Blank)';
const FN_LABEL = { SUM: 'SUM', COUNT: 'COUNT', COUNTA: 'COUNTA', COUNTUNIQUE: 'COUNTUNIQUE', AVERAGE: 'AVERAGE', MIN: 'MIN', MAX: 'MAX', MEDIAN: 'MEDIAN', PRODUCT: 'PRODUCT', STDEV: 'STDEV', VAR: 'VAR' };
const KEEPS_FORMAT = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN']);
const HEAD = { b: true };

/** The source as indexes, and its fields: one per column, named by the header row. */
export function pivotSource(eng, ctx, cfg) {
  const tab = ctx.tabById(cfg.src.tab);
  const rect = tab && ctx.rect(tab, cfg.src);
  if (!rect || rect.r2 <= rect.r1) return null;
  const width = rect.c2 - rect.c1 + 1;
  // A source past the budget is read from its first rows only.
  const r2 = Math.min(rect.r2, rect.r1 + Math.max(1, Math.floor(SOURCE_BUDGET / width)));
  const fields = [];
  for (let c = rect.c1; c <= rect.c2; c += 1) {
    const name = formatValue(eng.cellValue(tab, rect.r1, c), ctx.cell(tab, rect.r1, c)?.s) || `Column ${c - rect.c1 + 1}`;
    fields.push({ col: tab.cols[c], c, name });
  }
  return { tab, rect: { ...rect, r2 }, truncated: r2 < rect.r2, fields };
}

/** A label and an order key for one value of a row or column field. */
function labelOf(v, s, group) {
  if (v == null || v === '') return { label: BLANK, key: [2, ''] };
  if (isErr(v)) return { label: v.code, key: [1, v.code] };
  if (group && typeof v === 'number') {
    const { y, m } = ymdFromSerial(v);
    if (group === 'year') return { label: String(y), key: [0, y] };
    if (group === 'quarter') { const q = Math.ceil(m / 3); return { label: `Q${q} ${y}`, key: [0, y * 10 + q] }; }
    if (group === 'month') return { label: `${String(m).padStart(2, '0')}/${y}`, key: [0, y * 100 + m] };
    if (group === 'day') return { label: usDate(Math.floor(v)), key: [0, Math.floor(v)] };
  }
  return { label: formatValue(v, s), key: [0, v] };
}
const keyCmp = (a, b) => (a[0] - b[0]) || compare(a[1], b[1]);

/** One summary over the values of a group. */
export function summarize(fn, list) {
  const nums = [];
  let filled = 0;
  for (const v of list) {
    if (v == null || v === '') continue;
    filled += 1;
    if (typeof v === 'number') nums.push(v);
  }
  const sum = () => nums.reduce((s, x) => s + x, 0);
  switch (fn) {
    case 'SUM': return sum();
    case 'COUNT': return nums.length;
    case 'COUNTA': return filled;
    case 'COUNTUNIQUE': return new Set(list.filter((v) => v != null && v !== '').map((v) => (typeof v === 'string' ? 's:' + v.toLowerCase() : String(v)))).size;
    case 'AVERAGE': return nums.length ? sum() / nums.length : null;
    case 'MIN': { if (!nums.length) return null; let m = Infinity; for (const x of nums) if (x < m) m = x; return m; }
    case 'MAX': { if (!nums.length) return null; let m = -Infinity; for (const x of nums) if (x > m) m = x; return m; }
    case 'MEDIAN': {
      if (!nums.length) return null;
      const s = nums.slice().sort((x, y) => x - y), h = s.length >> 1;
      return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
    }
    case 'PRODUCT': return nums.length ? nums.reduce((p, x) => p * x, 1) : 0;
    case 'STDEV': case 'VAR': {
      if (nums.length < 2) return null;
      const m = sum() / nums.length;
      const v = nums.reduce((s, x) => s + (x - m) ** 2, 0) / (nums.length - 1);
      return fn === 'VAR' ? v : Math.sqrt(v);
    }
    default: return null;
  }
}

/** The distinct shown values of a source column (for the Filters checklist), with counts. */
export function pivotValues(eng, ctx, cfg, colId) {
  const src = pivotSource(eng, ctx, cfg);
  const f = src?.fields.find((x) => x.col === colId);
  if (!f) return [];
  const counts = new Map();
  for (let r = src.rect.r1 + 1; r <= src.rect.r2 && counts.size < 1000; r += 1) {
    const t = labelOf(eng.cellValue(src.tab, r, f.c), ctx.cell(src.tab, r, f.c)?.s, '').label;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => compare(a.text, b.text));
}

/**
 * The pivot's output: { cells: [[{v, s}]] } (null = empty), or { error }.
 * Rows: one per distinct combination of the Rows fields; columns: one per
 * combination of the Columns fields and Value; Grand Total row and column
 * when totals are on.
 */
export function computePivot(eng, ctx, cfg) {
  const src = pivotSource(eng, ctx, cfg);
  if (!src) return { error: 'The pivot source is gone or has no rows under its header' };
  const field = (col) => src.fields.find((f) => f.col === col);
  const rowF = (cfg.rows || []).map((x) => ({ ...x, f: field(x.col) })).filter((x) => x.f);
  const colF = (cfg.cols || []).map((x) => ({ ...x, f: field(x.col) })).filter((x) => x.f);
  const valF = (cfg.values || []).map((x) => ({ ...x, f: field(x.col) })).filter((x) => x.f);
  const filF = (cfg.filters || []).map((x) => ({ ...x, f: field(x.col), hide: new Set(x.hide || []) })).filter((x) => x.f && x.hide.size);
  const totals = cfg.totals !== false;
  const { tab, rect } = src;
  const val = (r, f) => eng.cellValue(tab, r, f.c);
  const styleAt = (r, f) => ctx.cell(tab, r, f.c)?.s;

  const rowKeys = new Map(), colKeys = new Map(), cellsBy = new Map();
  const add = (k, i, v) => { const key = `${k}\u0001${i}`; let l = cellsBy.get(key); if (!l) cellsBy.set(key, (l = [])); l.push(v); };
  for (let r = rect.r1 + 1; r <= rect.r2; r += 1) {
    if (filF.some((x) => x.hide.has(labelOf(val(r, x.f), styleAt(r, x.f), '').label))) continue;
    const rl = rowF.map((x) => labelOf(val(r, x.f), styleAt(r, x.f), x.group));
    const cl = colF.map((x) => labelOf(val(r, x.f), styleAt(r, x.f), x.group));
    const rk = JSON.stringify(rl.map((x) => x.label)), ck = JSON.stringify(cl.map((x) => x.label));
    if (!rowKeys.has(rk)) rowKeys.set(rk, rl);
    if (!colKeys.has(ck)) colKeys.set(ck, cl);
    valF.forEach((x, i) => {
      const v = val(r, x.f);
      add(`${rk}\u0002${ck}`, i, v); add(`${rk}\u0002*`, i, v); add(`*\u0002${ck}`, i, v); add('*\u0002*', i, v);
    });
  }
  // A combination with no rows behind it is blank, not 0 (Google Sheets).
  const agg = (rk, ck, i) => { const l = cellsBy.get(`${rk}\u0002${ck}\u0001${i}`); return l ? summarize(valF[i].fn, l) : null; };

  /** Order of the keys of one axis: by label per field, or by a value's total when a field says `by`. */
  const order = (keys, fieldsOf, totalOf) => {
    const list = [...keys.entries()];
    const byField = fieldsOf.find((x) => x.by != null && x.by < valF.length);
    list.sort(([ka, a], [kb, b]) => {
      if (byField) {
        const d = compare(totalOf(ka, byField.by) ?? 0, totalOf(kb, byField.by) ?? 0);
        if (d) return byField.sort === 'desc' ? -d : d;
      }
      for (let i = 0; i < fieldsOf.length; i += 1) {
        const d = keyCmp(a[i].key, b[i].key);
        if (d) return fieldsOf[i].sort === 'desc' ? -d : d;
      }
      return 0;
    });
    return list;
  };
  const rows = order(rowKeys, rowF, (rk, i) => agg(rk, '*', i));
  const cols = colF.length ? order(colKeys, colF, (ck, i) => agg('*', ck, i)) : [[JSON.stringify([]), []]];

  const nR = rowF.length, nV = valF.length;
  const groups = cols.map(([ck, labels]) => ({ ck, label: labels.map((x) => x.label).join(' / ') }));
  if (colF.length && totals) groups.push({ ck: '*', label: 'Grand Total', total: true });
  const width = nR + groups.length * Math.max(1, nV);
  const height = (colF.length ? 2 : 1) + rows.length + (totals && nR ? 1 : 0);
  if (width * height > OUTPUT_BUDGET) return { error: 'The pivot is too large to show - add a filter or fewer fields' };

  const vName = (x) => `${FN_LABEL[x.fn]} of ${x.f.name}`;
  const fmt = (i) => {
    const x = valF[i];
    if (x.show) return { nf: 'percent', d: 2 };
    if (!KEEPS_FORMAT.has(x.fn)) return null;
    const s = ctx.cell(tab, rect.r1 + 1, x.f.c)?.s;
    return s?.nf ? { nf: s.nf, ...(s.d != null ? { d: s.d } : {}) } : null;
  };
  /** The shown value: the summary, or its share of the row, column or grand total. */
  const shown = (rk, ck, i) => {
    const v = agg(rk, ck, i);
    const how = valF[i].show;
    if (!how || v == null) return v;
    const base = how === 'row' ? agg(rk, '*', i) : how === 'col' ? agg('*', ck, i) : agg('*', '*', i);
    return base ? v / base : null;
  };
  const cell = (v, s) => (v == null || v === '' ? null : { v, ...(s ? { s } : {}) });
  const out = [];
  const head = [];
  if (colF.length) {
    const top = Array(nR).fill(null);
    if (nR) top[0] = cell(colF.map((x) => x.f.name).join(' / '), HEAD);
    for (const g of groups) for (let i = 0; i < Math.max(1, nV); i += 1) top.push(cell(i === 0 || nV > 1 ? g.label : null, HEAD));
    out.push(top);
  }
  rowF.forEach((x) => head.push(cell(x.f.name, HEAD)));
  for (let g = 0; g < groups.length; g += 1) {
    if (!nV) head.push(null);
    for (let i = 0; i < nV; i += 1) head.push(cell(vName(valF[i]), HEAD));
  }
  out.push(head);
  for (const [rk, labels] of rows) {
    const line = labels.map((x) => cell(x.label, null));
    for (const g of groups) {
      if (!nV) { line.push(null); continue; }
      for (let i = 0; i < nV; i += 1) line.push(cell(shown(rk, g.ck, i), g.total ? { ...(fmt(i) || {}), b: true } : fmt(i)));
    }
    out.push(line);
  }
  if (!nR && nV) {
    // No Rows fields: one line of summaries.
    const line = [];
    for (const g of groups) for (let i = 0; i < nV; i += 1) line.push(cell(shown('*', g.ck, i), fmt(i)));
    out.push(line);
  }
  if (totals && nR) {
    const line = [cell('Grand Total', HEAD), ...Array(nR - 1).fill(null)];
    for (const g of groups) {
      if (!nV) { line.push(null); continue; }
      for (let i = 0; i < nV; i += 1) line.push(cell(shown('*', g.ck, i), { ...(fmt(i) || {}), b: true }));
    }
    out.push(line);
  }
  return { cells: out, truncated: src.truncated };
}

/** A new pivot's settings for a source range (ids) on tab `srcTab`, drawn at (atRowId, atColId). */
export const newPivot = (srcIds, srcTab, at) => ({ src: { tab: srcTab, ...srcIds }, at, rows: [], cols: [], values: [], filters: [], totals: true });
