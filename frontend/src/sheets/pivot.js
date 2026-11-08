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
import { labelKey } from './model.js';

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
  // Only a number that is a real date (01/01/1900 to 12/31/9999) groups; any other shows as itself.
  if (group && typeof v === 'number' && v >= 1 && v < 2958466) {
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
  for (let r = src.rect.r1 + 1; r <= src.rect.r2 && counts.size < 5000; r += 1) {
    const t = labelKey(labelOf(eng.cellValue(src.tab, r, f.c), ctx.cell(src.tab, r, f.c)?.s, '').label);
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
// Results kept between engine builds (every keystroke builds a new engine).
// ONLY for a plain source - no formula in its range, nothing on its tab that
// can spill, no pivot on its tab - whose values can change only by an edit to
// that tab. Keyed by the settings object (a new object on every settings
// write: readExtra hands back the same object until the stored entry
// changes) plus the versions of the source tab's cells, rows and columns.
const versions = new WeakMap();
function versionOf(ytype) {
  if (!ytype || typeof ytype.observe !== 'function') return null;
  let v = versions.get(ytype);
  if (!v) { v = { n: 0 }; versions.set(ytype, v); ytype.observe(() => { v.n += 1; }); }
  return v.n;
}
const results = new WeakMap();          // settings object -> { vs, out }
const tabFormulas = new WeakMap();      // tab view -> { cells: [{r, c}], spills: bool }
const SPILLS = /:|\b(FILTER|SORT|UNIQUE|SEQUENCE|TRANSPOSE|ARRAYFORMULA|SPLIT|OFFSET|INDIRECT)\s*\(|^=\s*[A-Za-z_][A-Za-z0-9_.]*\s*$/i;
function plainSource(ctx, tab, cfg) {
  if (tab.pivots?.size) return false;
  let info = tabFormulas.get(tab);
  if (!info) {
    info = { cells: [], spills: false };
    ctx.eachCell(tab, (r, c, cell) => { if (cell.f) { info.cells.push({ r, c }); if (SPILLS.test(cell.f)) info.spills = true; } });
    tabFormulas.set(tab, info);
  }
  if (info.spills) return false;
  const rect = ctx.rect(tab, cfg.src);
  return !!rect && !info.cells.some(({ r, c }) => r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2);
}
const TOO_LARGE = 'The pivot is too large to show - add a filter or fewer fields';
const NONE = [];
const SEPARATORS = ['\u0001', '\u0002', '\u0003'];     // the characters keys are joined with

export function computePivot(eng, ctx, cfg) {
  const srcTab = ctx.tabById(cfg.src?.tab);
  const vs = srcTab ? [versionOf(srcTab.cells), versionOf(srcTab.yrows), versionOf(srcTab.ycols)] : [null];
  const cacheable = vs.every((x) => x != null) && plainSource(ctx, srcTab, cfg);
  const key = vs.join('.');
  if (cacheable) {
    const hit = results.get(cfg);
    if (hit && hit.vs === key && hit.cells === srcTab.cells) return hit.out;
  }
  const out = computeFresh(eng, ctx, cfg);
  if (cacheable && !out.volatile) results.set(cfg, { vs: key, cells: srcTab.cells, out });
  return out;
}

function computeFresh(eng, ctx, cfg) {
  const src = pivotSource(eng, ctx, cfg);
  if (!src) return { error: 'The pivot source is gone or has no rows under its header' };
  const field = (col) => src.fields.find((f) => f.col === col);
  const rowF = (cfg.rows || []).map((x) => ({ ...x, f: field(x.col) })).filter((x) => x.f);
  const colF = (cfg.cols || []).map((x) => ({ ...x, f: field(x.col) })).filter((x) => x.f);
  // Each value keeps its index in the settings, so a field's `by` (an index there) finds it.
  const valF = (cfg.values || []).map((x, i0) => ({ ...x, i0, f: field(x.col) })).filter((x) => x.f);
  const filF = (cfg.filters || []).map((x) => ({ ...x, f: field(x.col), hide: new Set((x.hide || []).map(labelKey)), show: Array.isArray(x.show) ? new Set(x.show.map(labelKey)) : null }))
    .filter((x) => x.f && (x.hide.size || x.show));
  const totals = cfg.totals !== false;
  const { tab, rect } = src;
  let volatile = false;
  const used = [...rowF, ...colF, ...valF, ...filF].map((x) => x.f);
  const nV1 = Math.max(1, valF.length);
  /** Cells the output would take with this many row and column keys (headers and totals included). */
  const outputSize = (nRows, nCols) => (nRows + 3) * (rowF.length + (nCols + (colF.length && totals ? 1 : 0)) * nV1);
  const SEP = '\u0003';
  // The separators never appear inside a key (a label holding one is matched without it).
  const clean = (s) => {
    let t = String(s);
    for (const ch of SEPARATORS) if (t.includes(ch)) t = t.split(ch).join('');
    return t;
  };
  const keyOf = (labels) => (labels.length === 1 ? clean(labels[0].label) : labels.map((x) => clean(x.label)).join(SEP));

  const rowKeys = new Map(), colKeys = new Map(), cellsBy = new Map();
  const add = (k, i, v) => { const key = `${k}\u0001${i}`; let l = cellsBy.get(key); if (!l) cellsBy.set(key, (l = [])); l.push(v); };
  // Each field's cell is read once per row (value, style, formula or not).
  const rowCells = new Map();
  let curRow = -1;
  const read = (r, f) => {
    if (r !== curRow) { rowCells.clear(); curRow = r; }
    let x = rowCells.get(f.c);
    if (!x) {
      const cell = ctx.cell(tab, r, f.c);
      if (cell?.f) volatile = true;
      const plainValue = cell && cell.f == null && cell.v != null && cell.v !== '';
      x = { v: plainValue ? cell.v : eng.cellValue(tab, r, f.c), s: cell?.s };
      rowCells.set(f.c, x);
    }
    return x;
  };
  const lab = (r, f, group) => { const x = read(r, f); return labelOf(x.v, x.s, group); };
  for (let r = rect.r1 + 1; r <= rect.r2; r += 1) {
    if (!volatile) for (const f of used) read(r, f);
    if (filF.length && filF.some((x) => {
      const t = labelKey(lab(r, x.f, '').label);
      return x.hide.has(t) || (x.show && !x.show.has(t));
    })) continue;
    const rl = rowF.map((x) => lab(r, x.f, x.group));
    const cl = colF.length ? colF.map((x) => lab(r, x.f, x.group)) : NONE;
    const rk = keyOf(rl), ck = keyOf(cl);
    if (!rowKeys.has(rk)) {
      rowKeys.set(rk, rl);
      // Stop as soon as the output cannot fit - a 200,000-row unique key must not be read to the end.
      if (outputSize(rowKeys.size, Math.max(1, colKeys.size)) > OUTPUT_BUDGET) return { error: TOO_LARGE, volatile };
    }
    if (!colKeys.has(ck)) {
      colKeys.set(ck, cl);
      if (outputSize(rowKeys.size, colKeys.size) > OUTPUT_BUDGET) return { error: TOO_LARGE, volatile };
    }
    for (let i = 0; i < valF.length; i += 1) add(`${rk}\u0002${ck}`, i, read(r, valF[i].f).v);
  }
  // Row, column and grand totals from the combinations (one list write per row while scanning).
  for (const [key, list] of [...cellsBy.entries()]) {
    const [combo, i] = key.split('\u0001');
    const [rk, ck] = combo.split('\u0002');
    for (const k of [`${rk}\u0002*`, `*\u0002${ck}`, '*\u0002*']) {
      const kk = `${k}\u0001${i}`;
      let l = cellsBy.get(kk);
      if (!l) cellsBy.set(kk, (l = []));
      for (const v of list) l.push(v);
    }
  }
  // A combination with no rows behind it is blank, not 0 (Google Sheets).
  const agg = (rk, ck, i) => { const l = cellsBy.get(`${rk}\u0002${ck}\u0001${i}`); return l ? summarize(valF[i].fn, l) : null; };

  /** Order of the keys of one axis: by label per field, or by a value's total when a field says `by`. */
  const order = (keys, fieldsOf, totalOf) => {
    const list = [...keys.entries()];
    const byField = fieldsOf.find((x) => x.by != null && valF.some((v) => v.i0 === x.by));
    const byIndex = byField ? valF.findIndex((v) => v.i0 === byField.by) : -1;
    list.sort(([ka, a], [kb, b]) => {
      if (byField) {
        const d = compare(totalOf(ka, byIndex) ?? 0, totalOf(kb, byIndex) ?? 0);
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
  const cols = colF.length ? order(colKeys, colF, (ck, i) => agg('*', ck, i)) : [['', []]];

  const nR = rowF.length, nV = valF.length;
  const groups = cols.map(([ck, labels]) => ({ ck, label: labels.map((x) => x.label).join(' / ') }));
  if (colF.length && totals) groups.push({ ck: '*', label: 'Grand Total', total: true });
  const width = nR + groups.length * Math.max(1, nV);
  const height = (colF.length ? 2 : 1) + rows.length + (totals && nR ? 1 : 0);
  if (width * height > OUTPUT_BUDGET) return { error: TOO_LARGE, volatile };

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
    out.push(line);     // with no Rows fields this is the one line of summaries (its key is '[]')
  }
  if (totals && nR) {
    const line = [cell('Grand Total', HEAD), ...Array(nR - 1).fill(null)];
    for (const g of groups) {
      if (!nV) { line.push(null); continue; }
      for (let i = 0; i < nV; i += 1) line.push(cell(shown('*', g.ck, i), { ...(fmt(i) || {}), b: true }));
    }
    out.push(line);
  }
  return { cells: out, truncated: src.truncated, volatile };
}

/** A new pivot's settings for a source range (ids) on tab `srcTab`, drawn at (atRowId, atColId). */
export const newPivot = (srcIds, srcTab, at) => ({ src: { tab: srcTab, ...srcIds }, at, rows: [], cols: [], values: [], filters: [], totals: true });
