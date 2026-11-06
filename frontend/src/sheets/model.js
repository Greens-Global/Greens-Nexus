// Sheets: the workbook as a shared Yjs document.
//
//   tabs          Y.Array  the tab ids, in order
//   tabmeta       Y.Map    tab id -> {name, color, frozenRows, frozenCols}
//   rows:<tab>    Y.Array  that tab's row ids, top to bottom (STABLE ids)
//   cols:<tab>    Y.Array  its column ids, left to right
//   cells:<tab>   Y.Map    '<rowId>.<colId>' -> {v, f, s}
//   sizes:<tab>   Y.Map    row or column id -> px
//
// Rows and columns are ids, not numbers, so two people inserting and
// deleting at once never shift each other's cells; formulas are stored by
// those ids too (formula/parse.js). Every change made here is one
// doc.transact(..., LOCAL), so the undo manager takes back only your own.
import * as Y from 'yjs';
import { encodeFormula, decodeFormula, shiftFormula } from './formula/parse.js';

export const LOCAL = 'nx-local';
export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;
export const COL_W = 100;
export const ROW_H = 24;
export const MAX_CELLS = 500000;
export const MAX_ROWS = 200000, MAX_COLS = 2000;
const GROW_MAX = 10000;    // rows or columns one formula may add
export const MAX_TABS = 200;
const MAX_STR = 50000;

export function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => (x % 36).toString(36)).join('');
}
const ids = (n) => Array.from({ length: n }, newId);

export function newTabSnapshot(name = 'Sheet 1', rows = DEFAULT_ROWS, cols = DEFAULT_COLS) {
  return { id: newId(), name, color: '', frozenRows: 0, frozenCols: 0, rows: ids(rows), cols: ids(cols), cells: {}, sizes: {} };
}

/** A blank workbook: one tab, 1000 rows by 26 columns. */
export function newSheetContent() {
  return { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Sheet 1')] };
}

const tabsOf = (doc) => doc.getArray('tabs');
const metaOf = (doc) => doc.getMap('tabmeta');
export const rowsOf = (doc, tab) => doc.getArray('rows:' + tab);
export const colsOf = (doc, tab) => doc.getArray('cols:' + tab);
export const cellsOf = (doc, tab) => doc.getMap('cells:' + tab);
export const sizesOf = (doc, tab) => doc.getMap('sizes:' + tab);

// The rest of a tab, each a Y.Map keyed by stable ids so concurrent edits merge:
//   merges:<tab>  '<rowId>.<colId>' (top-left) -> {r2, c2} (bottom-right ids)
//   hidden:<tab>  row or column id -> true (hidden by hand; a filter hides on its own)
//   notes:<tab>   '<rowId>.<colId>' -> {text, by, at}
//   charts:<tab>  chart id -> {type, range, x, y, w, h, title, header}
//   cf:<tab>      rule id -> conditional format {range, type, a, b, f, style, colors, order}
//   dv:<tab>      rule id -> data validation {range, kind, items, src, op, a, b, reject}
//   filter:<tab>  'f' -> {r (header row), c1, c2, crit: {colId: {hide, op, a, b}}}
// and, for the whole workbook, names: lower-case name -> {name, tab, range}.
//   pivots:<tab>  pivot id -> {src: {tab, r1, c1, r2, c2}, at: {r, c}, rows, cols, values, filters, totals}
//   groups:<tab>  group id -> {axis: rows | cols, a, b (first and last id), collapsed}
export const EXTRAS = ['merges', 'hidden', 'notes', 'charts', 'cf', 'dv', 'filter', 'pivots', 'groups'];
export const extraOf = (doc, kind, tab) => doc.getMap(kind + ':' + tab);
export const namesOf = (doc) => doc.getMap('names');

function clearTab(doc, id) {
  const rows = rowsOf(doc, id), cols = colsOf(doc, id);
  if (rows.length) rows.delete(0, rows.length);
  if (cols.length) cols.delete(0, cols.length);
  cellsOf(doc, id).clear(); sizesOf(doc, id).clear();
  for (const k of EXTRAS) extraOf(doc, k, id).clear();
}

function writeTab(doc, t, at) {
  const tabs = tabsOf(doc);
  tabs.insert(at == null ? tabs.length : at, [t.id]);
  metaOf(doc).set(t.id, { name: t.name, color: t.color || '', frozenRows: t.frozenRows | 0, frozenCols: t.frozenCols | 0, ...(t.grid === false ? { grid: false } : {}) });
  clearTab(doc, t.id);
  rowsOf(doc, t.id).push(t.rows);
  colsOf(doc, t.id).push(t.cols);
  const cells = cellsOf(doc, t.id), sizes = sizesOf(doc, t.id);
  for (const [k, v] of Object.entries(t.cells || {})) cells.set(k, v);
  for (const [k, v] of Object.entries(t.sizes || {})) sizes.set(k, v);
  for (const kind of EXTRAS) {
    const m = extraOf(doc, kind, t.id);
    for (const [k, v] of Object.entries(t[kind] || {})) m.set(k, v);
  }
}

/** A shared document built from a stored snapshot. */
export function seedSheetDoc(snapshot) {
  const doc = new Y.Doc();
  const snap = snapshot?.type === 'nexus-sheet' && snapshot.tabs?.length ? snapshot : newSheetContent();
  doc.transact(() => {
    for (const t of snap.tabs) writeTab(doc, t);
    for (const [k, v] of Object.entries(snap.names || {})) namesOf(doc).set(k, v);
  });
  return doc;
}

/** The workbook as a snapshot (what the server stores). Cells of deleted rows or columns are left out. */
export function snapshotOf(doc) {
  const meta = metaOf(doc);
  // Everything is cut to the sheet's limits here, so what is saved always opens again.
  let budget = MAX_CELLS;
  return {
    type: 'nexus-sheet', v: 1,
    tabs: usableTabs(doc).map(({ id, rows, cols }) => {
      const m = tabMeta(meta.get(id));
      const rs = new Set(rows), cs = new Set(cols);
      const cells = {};
      cellsOf(doc, id).forEach((v, k) => {
        const [r, c] = k.split('.');
        if (budget <= 0 || !rs.has(r) || !cs.has(c)) return;
        const clean = cleanCell(v);
        if (clean) { cells[k] = clean; budget -= 1; }
      });
      const sizes = {};
      sizesOf(doc, id).forEach((v, k) => { if ((rs.has(k) || cs.has(k)) && typeof v === 'number' && v >= 4 && v <= 2000) sizes[k] = v; });
      const out = { id, name: m.name, color: m.color, frozenRows: m.frozenRows, frozenCols: m.frozenCols, rows, cols, cells, sizes };
      if (m.grid === false) out.grid = false;
      for (const kind of EXTRAS) {
        const got = readExtra(doc, kind, id);
        if (got.size) out[kind] = Object.fromEntries(got);
      }
      return out;
    }),
    ...(namesOf(doc).size ? { names: Object.fromEntries(readNames(doc)) } : {}),
  };
}

// ── is a stored state safe to put on screen? ─────────────────────────────
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const NF = new Set(['', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'text']);
const HA = new Set(['left', 'center', 'right']);
const VA = new Set(['top', 'middle', 'bottom']);
export const FONTS = ['Inter', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS'];
const FONT_SET = new Set(FONTS);
export const BORDER_STYLES = ['thin', 'medium', 'thick', 'dashed', 'dotted'];
/** Text rotation: degrees counterclockwise (45 = tilt up), or 'v' for letters stacked top to bottom. */
export const ROTATIONS = [45, -45, 90, -90, 'v'];
const BORDER_RE = /^(thin|medium|thick|dashed|dotted) #[0-9a-fA-F]{3,8}$/;
const plain = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

/** A link a cell may carry: http, https or mailto only, normalized; '' for anything else. */
export function safeLink(u) {
  if (typeof u !== 'string' || !u || u.length > 2000) return '';
  const t = u.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(t)) return '';
  try {
    const p = new URL(t);
    return ['http:', 'https:', 'mailto:'].includes(p.protocol) ? p.href : '';
  } catch { return ''; }
}

export function validStyle(s) {
  if (s == null) return true;
  if (!plain(s)) return false;
  for (const [k, v] of Object.entries(s)) {
    if (['b', 'i', 'u', 'st', 'wrap'].includes(k)) { if (typeof v !== 'boolean') return false; }
    else if (k === 'fc' || k === 'bg') { if (typeof v !== 'string' || !COLOR_RE.test(v)) return false; }
    else if (k === 'ha') { if (!HA.has(v)) return false; }
    else if (k === 'nf') { if (!NF.has(v)) return false; }
    else if (k === 'd') { if (!Number.isInteger(v) || v < 0 || v > 10) return false; }
    else if (k === 'va') { if (!VA.has(v)) return false; }
    else if (k === 'ff') { if (!FONT_SET.has(v)) return false; }
    else if (k === 'fs') { if (!Number.isInteger(v) || v < 6 || v > 96) return false; }
    else if (k === 'bt' || k === 'bb' || k === 'bl' || k === 'br') { if (typeof v !== 'string' || !BORDER_RE.test(v)) return false; }
    else if (k === 'rot') { if (!ROTATIONS.includes(v)) return false; }
    else return false;
  }
  return true;
}
export function validCell(c) {
  if (!plain(c)) return false;
  for (const k of Object.keys(c)) if (!['v', 'f', 's', 'l'].includes(k)) return false;
  const { v, f } = c;
  if (c.l != null && !safeLink(c.l)) return false;
  if (!(v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_STR))) return false;
  if (f != null && (typeof f !== 'string' || f[0] !== '=' || f.length > MAX_STR)) return false;
  return validStyle(c.s);
}

/**
 * Throws ONLY when the workbook's skeleton cannot be used: a shared type of
 * the wrong kind (a map where a list belongs), or no tab left with rows,
 * columns and a name. A throw resets everyone's live session, so anything
 * smaller - one bad cell, an unknown style key from a newer version, a rule,
 * pivot or note that does not check out, a string past its cap, too many of
 * something - is dropped or cut on read and in snapshotOf instead.
 */
export function validateSheetDoc(doc) {
  const fail = (why) => { throw new Error(`Not a sheet: ${why}`); };
  let tabs;
  try { tabs = tabsOf(doc).toArray(); metaOf(doc); namesOf(doc); } catch { fail('structure'); }
  for (const id of tabs.slice(0, MAX_TABS)) {
    if (!isId(id)) continue;
    try {
      rowsOf(doc, id); colsOf(doc, id); cellsOf(doc, id); sizesOf(doc, id);
      for (const kind of EXTRAS) extraOf(doc, kind, id);
    } catch { fail(`tab ${id} structure`); }
  }
  if (!usableTabs(doc).length) fail('no usable tab');
}

/** The tabs a read can use: listed, named in tabmeta, with id rows and columns (bad ids left out). */
function usableTabs(doc) {
  const meta = metaOf(doc);
  const out = [];
  const seen = new Set();
  for (const id of tabsOf(doc).toArray()) {
    if (out.length >= MAX_TABS) break;
    if (!isId(id) || seen.has(id) || !meta.has(id)) continue;
    seen.add(id);
    const rows = rowsOf(doc, id).toArray().filter(isId).slice(0, MAX_ROWS);
    const cols = colsOf(doc, id).toArray().filter(isId).slice(0, MAX_COLS);
    if (rows.length && cols.length) out.push({ id, rows, cols });
  }
  return out;
}
/** A tab's settings, every field checked (a bad one falls back to its default). */
function tabMeta(m0) {
  const m = plain(m0) ? m0 : {};
  const frozen = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(100, v)) : 0);
  return {
    name: typeof m.name === 'string' && m.name ? m.name.slice(0, 100) : 'Sheet',
    color: typeof m.color === 'string' && COLOR_RE.test(m.color) ? m.color : '',
    frozenRows: frozen(m.frozenRows), frozenCols: frozen(m.frozenCols), grid: m.grid !== false,
  };
}
/**
 * A stored cell made safe to show: a bad value, formula or link is left out,
 * an unknown or bad style key dropped, an over-long text cut. null when
 * nothing usable is left. A cell that already checks out is returned as is.
 */
export function cleanCell(c) {
  if (!plain(c)) return null;
  if (validCell(c)) return c;
  const out = {};
  const v = c.v;
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out.v = v;
  else if (typeof v === 'string') out.v = v.slice(0, MAX_STR);
  if (typeof c.f === 'string' && c.f[0] === '=' && c.f.length <= MAX_STR) out.f = c.f;
  const l = c.l != null ? safeLink(c.l) : '';
  if (l) out.l = l;
  if (plain(c.s)) {
    const s = {};
    for (const [k, val] of Object.entries(c.s)) if (validStyle({ [k]: val })) s[k] = val;
    if (Object.keys(s).length) out.s = s;
  }
  return Object.keys(out).length ? out : null;
}

/** How many of each a tab (or, for names, the workbook) keeps; reads and saves stop here. */
export const LIMITS = { merges: 20000, hidden: MAX_ROWS + MAX_COLS, notes: 20000, charts: 50, cf: 200, dv: 500, filter: 1, names: 1000, pivots: 20, groups: 200 };
/** Cells one format, border or link may touch at once. */
export const AREA_MAX = 100000;
/** Cells in the whole workbook (stored cells count, empty ones do not). */
export const cellCount = (doc) => tabsOf(doc).toArray().reduce((s, id) => s + cellsOf(doc, id).size, 0);

const isId = (x) => typeof x === 'string' && ID_RE.test(x);
const isRange = (g) => plain(g) && ['r1', 'c1', 'r2', 'c2'].every((k) => isId(g[k]));
const isStr = (x, n) => typeof x === 'string' && x.length <= n;
const isNum = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const isScalar = (x) => x == null || isNum(x, -1e300, 1e300) || isStr(x, 500);
const isFormula = (x) => typeof x === 'string' && x[0] === '=' && x.length <= 2000;
const isKey = (k) => typeof k === 'string' && k.split('.').length === 2 && k.split('.').every(isId);
export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'scatter'];
export const CF_TYPES = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains', 'notContains', 'before', 'after', 'empty', 'notEmpty', 'formula', 'scale'];
export const DV_KINDS = ['list', 'range', 'checkbox', 'number', 'date'];
export const DV_OPS = ['between', 'gte', 'lte', 'gt', 'lt', 'eq'];
export const FILTER_OPS = ['', 'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains', 'notContains', 'empty', 'notEmpty'];
const CF_STYLE_KEYS = new Set(['fc', 'bg', 'b', 'i', 'u', 'st']);
const VALID = {
  merges: (v, k) => isKey(k) && plain(v) && isId(v.r2) && isId(v.c2),
  hidden: (v, k) => v === true && isId(k),
  notes: (v, k) => isKey(k) && plain(v) && isStr(v.text, 5000) && v.text.length > 0 && (v.by == null || isStr(v.by, 120)) && (v.at == null || isStr(v.at, 40)),
  charts: (v, k) => isId(k) && plain(v) && CHART_TYPES.includes(v.type) && isRange(v.range) && isNum(v.x, 0, 1e6) && isNum(v.y, 0, 1e7)
    && isNum(v.w, 160, 2000) && isNum(v.h, 120, 2000) && (v.title == null || isStr(v.title, 200)) && (v.header == null || typeof v.header === 'boolean'),
  cf: (v, k) => isId(k) && plain(v) && isRange(v.range) && CF_TYPES.includes(v.type) && isScalar(v.a) && isScalar(v.b) && (v.f == null || isFormula(v.f))
    && (v.style == null || (validStyle(v.style) && Object.keys(v.style).every((x) => CF_STYLE_KEYS.has(x))))
    && (v.colors == null || (Array.isArray(v.colors) && v.colors.length >= 2 && v.colors.length <= 3 && v.colors.every((c) => typeof c === 'string' && COLOR_RE.test(c))))
    && (v.order == null || isNum(v.order, -1e15, 1e15)),
  dv: (v, k) => isId(k) && plain(v) && isRange(v.range) && DV_KINDS.includes(v.kind)
    && (v.items == null || (Array.isArray(v.items) && v.items.length <= 500 && v.items.every((x) => isStr(x, 200))))
    && (v.src == null || isFormula(v.src)) && (v.op == null || DV_OPS.includes(v.op)) && isScalar(v.a) && isScalar(v.b)
    && (v.reject == null || typeof v.reject === 'boolean'),
  filter: (v, k) => k === 'f' && plain(v) && isId(v.r) && isId(v.c1) && isId(v.c2) && (v.crit == null || (plain(v.crit)
    && Object.keys(v.crit).length <= MAX_COLS && Object.entries(v.crit).every(([ck, cv]) => isId(ck) && plain(cv)
      && (cv.hide == null || (Array.isArray(cv.hide) && cv.hide.length <= 5000 && cv.hide.every((x) => isStr(x, 500))))
      && (cv.op == null || FILTER_OPS.includes(cv.op)) && isScalar(cv.a) && isScalar(cv.b)))),
  pivots: (v, k) => isId(k) && plain(v) && plain(v.src) && isId(v.src.tab) && isRange(v.src) && plain(v.at) && isId(v.at.r) && isId(v.at.c)
    && fields(v.rows, 5, axisField) && fields(v.cols, 5, axisField) && fields(v.values, 10, valueField) && fields(v.filters, 10, filterField)
    && (v.totals == null || typeof v.totals === 'boolean'),
  groups: (v, k) => isId(k) && plain(v) && (v.axis === 'rows' || v.axis === 'cols') && isId(v.a) && isId(v.b) && (v.collapsed == null || typeof v.collapsed === 'boolean'),
};
export const PIVOT_FNS = ['SUM', 'COUNT', 'COUNTA', 'COUNTUNIQUE', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN', 'PRODUCT', 'STDEV', 'VAR'];
export const PIVOT_SHOW = ['', 'row', 'col', 'total'];
export const PIVOT_GROUPS = ['', 'year', 'quarter', 'month', 'day'];
const fields = (list, max, ok) => list == null || (Array.isArray(list) && list.length <= max && list.every(ok));
const axisField = (f) => plain(f) && isId(f.col) && (f.sort == null || f.sort === 'asc' || f.sort === 'desc')
  && (f.by == null || (Number.isInteger(f.by) && f.by >= 0 && f.by < 10)) && (f.group == null || PIVOT_GROUPS.includes(f.group));
const valueField = (f) => plain(f) && isId(f.col) && PIVOT_FNS.includes(f.fn) && (f.show == null || PIVOT_SHOW.includes(f.show));
// hide: labels left out; show (when set): only these labels kept - Clear with any number of distinct values.
const labelList = (x) => x == null || (Array.isArray(x) && x.length <= 5000 && x.every((s) => isStr(s, 500)));
const filterField = (f) => plain(f) && isId(f.col) && labelList(f.hide) && labelList(f.show);
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** A name may not read as a cell (B2), a boolean or an R1C1 address. */
export const okName = (n) => typeof n === 'string' && NAME_RE.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n) && !/^(true|false)$/i.test(n) && !/^R\d*C\d*$/i.test(n);
const validName = (v, k) => plain(v) && okName(v.name) && v.name.toLowerCase() === k && isId(v.tab) && isRange(v.range);

/** The valid entries of one of a tab's extra maps (a live edit is read this way, never trusted). */
export function readExtra(doc, kind, id) {
  const out = new Map();
  const cap = LIMITS[kind];
  for (const [k, v0] of extraOf(doc, kind, id).entries()) {
    if (out.size >= cap) break;
    const v = cleanExtra(kind, v0);
    if (v && VALID[kind](v, k)) out.set(k, v);
  }
  return out;
}

const STRING_CAP = 500;
const cutList = (list, n, len) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, len)) : list);
const cutStr = (x, n) => (typeof x === 'string' ? x.slice(0, n) : x);
/**
 * An extra entry with what can be cut, cut (long texts, long lists): a
 * 600-character filter label or note keeps its entry rather than losing it.
 * Remembered per stored object. Anything still wrong after this is dropped by VALID.
 */
const cleaned = new WeakMap();
function cleanExtra(kind, v) {
  if (!plain(v)) return v;
  if (cleaned.has(v)) return cleaned.get(v);
  let out = v;
  switch (kind) {
    case 'notes': out = { ...v, text: cutStr(v.text, 5000), by: cutStr(v.by, 120), at: cutStr(v.at, 40) }; break;
    case 'charts': out = { ...v, title: cutStr(v.title, 200), w: typeof v.w === 'number' ? Math.max(160, Math.min(2000, v.w)) : v.w, h: typeof v.h === 'number' ? Math.max(120, Math.min(2000, v.h)) : v.h }; break;
    case 'cf': out = { ...v, a: cutStr(v.a, STRING_CAP), b: cutStr(v.b, STRING_CAP) }; break;
    case 'dv': out = { ...v, items: cutList(v.items, 500, 200), a: cutStr(v.a, STRING_CAP), b: cutStr(v.b, STRING_CAP) }; break;
    case 'filter':
      if (plain(v.crit)) {
        const crit = {};
        for (const [ck, cv] of Object.entries(v.crit)) crit[ck] = plain(cv) ? { ...cv, hide: cutList(cv.hide, 5000, STRING_CAP), a: cutStr(cv.a, STRING_CAP), b: cutStr(cv.b, STRING_CAP) } : cv;
        out = { ...v, crit };
      }
      break;
    case 'pivots': {
      const f = (list, n) => (Array.isArray(list) ? list.slice(0, n) : list);
      out = {
        ...v, rows: f(v.rows, 5), cols: f(v.cols, 5), values: f(v.values, 10),
        filters: Array.isArray(v.filters) ? v.filters.slice(0, 10).map((x) => (plain(x) ? { ...x, hide: cutList(x.hide, 5000, STRING_CAP), show: cutList(x.show, 5000, STRING_CAP) } : x)) : v.filters,
      };
      for (const part of ['rows', 'cols', 'values', 'filters']) if (out[part] === undefined) delete out[part];
      break;
    }
    default: break;
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  cleaned.set(v, out);
  return out;
}
/** Filter labels are compared at the length they are stored at. */
export const labelKey = (s) => String(s ?? '').slice(0, STRING_CAP);
export function readNames(doc) {
  const out = new Map();
  for (const [k, v] of namesOf(doc).entries()) {
    if (out.size >= LIMITS.names) break;
    if (validName(v, k)) out.set(k, v);
  }
  return out;
}

// ── reading ──────────────────────────────────────────────────────────────
/**
 * A read view for the formula engine and the grid: tabs as plain
 * {id, name, color, frozenRows, frozenCols, rows, cols} plus lookups.
 * `grow` (only inside a LOCAL transaction) lets encodeFormula reach a row or
 * column past the end by adding it.
 */
export function buildCtx(doc, { grow = false } = {}) {
  const meta = metaOf(doc);
  // A live edit arrives after the mount check: every field is read defensively.
  const tabs = usableTabs(doc).map(({ id, rows, cols }) => ({
    id, ...tabMeta(meta.get(id)), rows, cols,
    cells: cellsOf(doc, id), sizes: sizesOf(doc, id), yrows: rowsOf(doc, id), ycols: colsOf(doc, id),
    ...Object.fromEntries(EXTRAS.map((kind) => [kind, readExtra(doc, kind, id)])),
  }));
  return makeCtx(tabs, grow ? (tab, axis, n) => {
    const fresh = ids(n);
    (axis === 'rows' ? rowsOf(doc, tab.id) : colsOf(doc, tab.id)).push(fresh);
    return fresh;
  } : null, readNames(doc));
}

/** The same view over plain tabs (cells/sizes as Map-like or plain objects). */
const checked = new WeakMap();
/** cleanCell, remembered per stored object (a Y.Map hands back the same object until it changes). */
function okCell(x) {
  if (!x || typeof x !== 'object') return null;
  if (!checked.has(x)) checked.set(x, cleanCell(x));
  return checked.get(x);
}

export function makeCtx(tabs, grow, names = new Map()) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const byName = new Map(tabs.map((t) => [t.name.toLowerCase(), t]));
  const idx = new WeakMap();
  const indexOf = (tab, axis, id) => {
    let m = idx.get(tab);
    if (!m) { m = {}; idx.set(tab, m); }
    if (!m[axis]) m[axis] = new Map(tab[axis].map((x, i) => [x, i]));
    const i = m[axis].get(id);
    return i == null ? -1 : i;
  };
  const get = (o, k) => (typeof o.get === 'function' ? o.get(k) : o[k]);
  const idAt = (tab, axis, i) => {
    if (i >= tab[axis].length) {
      if (!grow) return newId();      // a read-only view cannot add the row: an id nobody has, so it reads #REF!
      // Never past the sheet's limits, and at most GROW_MAX at a time: one typed
      // =A900000 must not make the sheet too big to save. Beyond that it reads #REF!.
      if (i >= (axis === 'rows' ? MAX_ROWS : MAX_COLS) || i + 1 - tab[axis].length > GROW_MAX) return newId();
      const add = grow(tab, axis, i + 1 - tab[axis].length);
      tab[axis].push(...add);
      idx.delete(tab);
    }
    return tab[axis][i];
  };
  return {
    tabs, byId,
    tabById: (id) => byId.get(id) || null,
    tabByName: (name) => byName.get(String(name).toLowerCase()) || null,
    rowIndex: (tab, id) => indexOf(tab, 'rows', id),
    colIndex: (tab, id) => indexOf(tab, 'cols', id),
    rowId: (tab, i) => idAt(tab, 'rows', i),
    colId: (tab, i) => idAt(tab, 'cols', i),
    cell: (tab, r, c) => {
      const rid = tab.rows[r], cid = tab.cols[c];
      const x = rid && cid ? get(tab.cells, rid + '.' + cid) : undefined;
      return okCell(x) || undefined;
    },
    size: (tab, id, dflt) => { const v = get(tab.sizes, id); return typeof v === 'number' && v >= 4 && v <= 2000 ? v : dflt; },
    /** {r1, c1, r2, c2} as indexes for a range stored by ids, or null when a row or column is gone. */
    rect: (tab, g) => {
      if (!tab || !g) return null;
      const r1 = indexOf(tab, 'rows', g.r1), r2 = indexOf(tab, 'rows', g.r2), c1 = indexOf(tab, 'cols', g.c1), c2 = indexOf(tab, 'cols', g.c2);
      if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
      return { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) };
    },
    names,
    /** A named range: { tab, r1, c1, r2, c2 } or null. */
    nameRef: (name) => {
      const n = names.get(String(name).toLowerCase());
      const tab = n ? byId.get(n.tab) : null;
      if (!tab) return null;
      const r1 = indexOf(tab, 'rows', n.range.r1), r2 = indexOf(tab, 'rows', n.range.r2), c1 = indexOf(tab, 'cols', n.range.c1), c2 = indexOf(tab, 'cols', n.range.c2);
      if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
      return { tab, r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) };
    },
  };
}

/** A range of indexes on a tab -> the ids it is stored by. */
export const rangeIds = (tab, { r1, c1, r2, c2 }) => ({ r1: tab.rows[r1], c1: tab.cols[c1], r2: tab.rows[r2], c2: tab.cols[c2] });

/** The A1 text of a stored cell's formula. */
export const formulaText = (ctx, tabId, f) => decodeFormula(f, ctx, tabId);

// ── changes (each one LOCAL transaction) ─────────────────────────────────
export const change = (doc, fn) => doc.transact(fn, LOCAL);
const sameObj = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Store one cell. `room` keeps the workbook under MAX_CELLS: a cell that does
 * not exist yet is only made while there is room (else it is counted in
 * room.skipped and the caller says so) - a save can never outgrow what opens.
 */
function putCell(map, key, next, room) {
  const clean = {};
  if (next.v != null && next.v !== '') clean.v = next.v;
  if (next.f) clean.f = next.f;
  if (next.s && Object.keys(next.s).length) clean.s = next.s;
  if (next.l) clean.l = next.l;
  if (!Object.keys(clean).length) { if (map.has(key)) { map.delete(key); if (room) room.left += 1; } return; }
  if (!map.has(key)) {
    if (room && room.left <= 0) { room.skipped += 1; return; }
    if (room) room.left -= 1;
  }
  if (!sameObj(map.get(key), clean)) map.set(key, clean);
}
const roomIn = (doc) => ({ left: MAX_CELLS - cellCount(doc), skipped: 0 });
/** The cells of a range: every position, or (for a big range) only the cells that exist. */
function eachInRange(tab, map, ctx, { r1, c1, r2, c2 }, skipRows, fn, { existingOnly = false } = {}) {
  const area = (r2 - r1 + 1) * (c2 - c1 + 1);
  if (area > AREA_MAX || (existingOnly && area > map.size * 4)) {
    for (const key of Array.from(map.keys())) {
      const [ri, ci] = key.split('.');
      const r = ctx.rowIndex(tab, ri), c = ctx.colIndex(tab, ci);
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2 && !skipRows?.has(r)) fn(r, c, key);
    }
    return area > AREA_MAX;
  }
  for (let r = r1; r <= r2; r += 1) {
    if (skipRows?.has(r)) continue;
    for (let c = c1; c <= c2; c += 1) fn(r, c, ctx.rowId(tab, r) + '.' + ctx.colId(tab, c));
  }
  return false;
}

/**
 * Write cells: [{r, c, v?, f?(A1 text), s?, l?}] on one tab. A formula is
 * encoded here (and may grow the tab); v/f replace the content, s / l replace
 * the style / link when given. Returns how many new cells did not fit.
 */
export function writeCells(doc, tabId, list) {
  let skipped = 0;
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    if (!tab) return;
    const map = cellsOf(doc, tabId);
    const room = roomIn(doc);
    for (const it of list) {
      const key = ctx.rowId(tab, it.r) + '.' + ctx.colId(tab, it.c);
      const cur = map.get(key) || {};
      let f = null;
      if (it.f) { try { f = encodeFormula(it.f, ctx, tabId); } catch { f = it.f; } }
      putCell(map, key, { v: f ? null : it.v, f, s: it.s !== undefined ? it.s : cur.s, l: it.l !== undefined ? it.l : cur.l }, room);
    }
    skipped = room.skipped;
  });
  return skipped;
}

/** Put stored cells (formulas already encoded) at positions. */
export function placeRaw(doc, tabId, list) {
  let skipped = 0;
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    const room = roomIn(doc);
    for (const it of list) putCell(map, ctx.rowId(tab, it.r) + '.' + ctx.colId(tab, it.c), it.cell || {}, room);
    skipped = room.skipped;
  });
  return skipped;
}

const patched = (cur, patch) => {
  const s = { ...(cur.s || {}) };
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === false || v === '') delete s[k]; else s[k] = v; }
  return s;
};
/**
 * Merge a style patch into every cell of the range (null removes a key).
 * A range over AREA_MAX restyles only the cells that exist. Rows in
 * skipRows (the ones a filter hides) are left alone. Returns new cells that did not fit.
 */
export function styleRange(doc, tabId, rect, patch, { skipRows } = {}) {
  let skipped = 0;
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    const room = roomIn(doc);
    eachInRange(tab, map, ctx, rect, skipRows, (r, c, key) => { const cur = map.get(key) || {}; putCell(map, key, { ...cur, s: patched(cur, patch) }, room); });
    skipped = room.skipped;
  });
  return skipped;
}

/** A style patch per cell ([{r, c, patch}]) in one step - borders, Clear Formatting of a block. */
export function styleCells(doc, tabId, list) {
  let skipped = 0;
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    const room = roomIn(doc);
    for (const { r, c, patch } of list) {
      const key = ctx.rowId(tab, r) + '.' + ctx.colId(tab, c);
      const cur = map.get(key) || {};
      putCell(map, key, { ...cur, s: patched(cur, patch) }, room);
    }
    skipped = room.skipped;
  });
  return skipped;
}

/** Clear the content (keep the formatting) of a range; skipRows are left as they are. */
export function clearRange(doc, tabId, rect, { formats = false, skipRows } = {}) {
  change(doc, () => {
    const ctx = buildCtx(doc);
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    const r2 = Math.min(rect.r2, tab.rows.length - 1), c2 = Math.min(rect.c2, tab.cols.length - 1);
    eachInRange(tab, map, ctx, { ...rect, r2, c2 }, skipRows, (r, c, key) => {
      const cur = map.get(key);
      if (cur) putCell(map, key, formats ? {} : { s: cur.s });
    }, { existingOnly: true });
  });
}

export function insertLines(doc, tabId, axis, at, n = 1) {
  change(doc, () => { (axis === 'rows' ? rowsOf : colsOf)(doc, tabId).insert(at, ids(n)); });
}

export function deleteLines(doc, tabId, axis, at, n = 1) {
  change(doc, () => {
    const arr = (axis === 'rows' ? rowsOf : colsOf)(doc, tabId);
    const len = arr.length;
    n = Math.min(n, len - at);
    if (n <= 0 || n >= len) return;              // the last row or column always stays
    const gone = new Set(arr.slice(at, at + n));
    arr.delete(at, n);
    const map = cellsOf(doc, tabId);
    for (const key of Array.from(map.keys())) {
      const [r, c] = key.split('.');
      if (gone.has(axis === 'rows' ? r : c)) map.delete(key);
    }
    const sizes = sizesOf(doc, tabId), hidden = extraOf(doc, 'hidden', tabId);
    for (const id of gone) { if (sizes.has(id)) sizes.delete(id); if (hidden.has(id)) hidden.delete(id); }
    // A note or merge whose corner went with the row or column goes too; ranges
    // stored by ids (rules, charts, names) simply stop reading once an end is gone.
    for (const kind of ['notes', 'merges']) {
      const m = extraOf(doc, kind, tabId);
      for (const [key, v] of Array.from(m.entries())) {
        const [r, c] = key.split('.');
        if (gone.has(axis === 'rows' ? r : c) || (kind === 'merges' && gone.has(axis === 'rows' ? v?.r2 : v?.c2))) m.delete(key);
      }
    }
    // Pivots and groups hold on to the nearest survivor: a first row (column)
    // that went moves to the one after the cut, a last one to the one before;
    // with nothing left between them, the entry goes.
    const ids2 = arr.toArray();
    const pos = new Map(ids2.map((x, i) => [x, i]));
    const after = ids2.length ? ids2[Math.min(at, ids2.length - 1)] : null;
    const before = at > 0 ? ids2[at - 1] : null;
    const [k1, k2] = axis === 'rows' ? ['r1', 'r2'] : ['c1', 'c2'];
    const corner = axis === 'rows' ? 'r' : 'c';
    const piv = extraOf(doc, 'pivots', tabId);
    for (const [key, v] of Array.from(piv.entries())) {
      if (plain(v) && plain(v.at) && gone.has(v.at[corner])) {
        if (after) piv.set(key, { ...v, at: { ...v.at, [corner]: after } }); else piv.delete(key);
      }
    }
    for (const t of tabsOf(doc).toArray()) {
      if (!isId(t)) continue;
      const m = extraOf(doc, 'pivots', t);
      for (const [key, v] of Array.from(m.entries())) {
        if (!plain(v) || !plain(v.src) || v.src.tab !== tabId || (!gone.has(v.src[k1]) && !gone.has(v.src[k2]))) continue;
        const a = gone.has(v.src[k1]) ? after : v.src[k1], b = gone.has(v.src[k2]) ? before : v.src[k2];
        if (!a || !b || pos.get(a) > pos.get(b)) m.delete(key);
        else m.set(key, { ...v, src: { ...v.src, [k1]: a, [k2]: b } });
      }
    }
    const groups = extraOf(doc, 'groups', tabId);
    for (const [key, g] of Array.from(groups.entries())) {
      if (!plain(g) || g.axis !== axis || (!gone.has(g.a) && !gone.has(g.b))) continue;
      const a = gone.has(g.a) ? after : g.a, b = gone.has(g.b) ? before : g.b;
      if (!a || !b || pos.get(a) > pos.get(b)) groups.delete(key);
      else groups.set(key, { ...g, a, b });
    }
  });
}

/** Set (or with null, remove) one entry of a tab's extra map. */
export function setExtra(doc, kind, tabId, key, value) {
  change(doc, () => {
    const m = extraOf(doc, kind, tabId);
    if (value == null) { if (m.has(key)) m.delete(key); } else m.set(key, value);
  });
}
/** Several entries at once, one undo step: [[kind, key, value|null], ...]. */
export function setExtras(doc, tabId, list) {
  change(doc, () => {
    for (const [kind, key, value] of list) {
      const m = extraOf(doc, kind, tabId);
      if (value == null) { if (m.has(key)) m.delete(key); } else m.set(key, value);
    }
  });
}
export function setName(doc, key, value) {
  change(doc, () => { const m = namesOf(doc); if (value == null) m.delete(key); else m.set(key, value); });
}

export const setSize = (doc, tabId, id, px) => change(doc, () => { sizesOf(doc, tabId).set(id, Math.max(16, Math.min(2000, Math.round(px)))); });

export function setTabMeta(doc, tabId, patch) {
  change(doc, () => { const m = metaOf(doc); m.set(tabId, { ...(m.get(tabId) || {}), ...patch }); });
}

export function uniqueTabName(doc, base) {
  const taken = new Set(Array.from(metaOf(doc).values(), (m) => (m?.name || '').toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k += 1) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
}

/** A new tab (null when the workbook already has MAX_TABS). */
export function addTab(doc, snapshotTab, at) {
  if (tabsOf(doc).length >= MAX_TABS) return null;
  const t = snapshotTab || newTabSnapshot();
  t.name = uniqueTabName(doc, t.name || 'Sheet');
  change(doc, () => writeTab(doc, t, at));
  return t.id;
}

export function duplicateTab(doc, tabId) {
  const src = snapshotOf(doc).tabs.find((t) => t.id === tabId);
  if (!src) return null;
  const at = tabsOf(doc).toArray().indexOf(tabId) + 1;
  // Same row and column ids: the copy's own-tab formulas point at the copy.
  return addTab(doc, { ...src, id: newId(), name: `Copy of ${src.name}` }, at);
}

export function deleteTab(doc, tabId) {
  change(doc, () => {
    const tabs = tabsOf(doc);
    if (tabs.length <= 1) return;
    const i = tabs.toArray().indexOf(tabId);
    if (i < 0) return;
    tabs.delete(i, 1);
    metaOf(doc).delete(tabId);
    clearTab(doc, tabId);
  });
}

export function moveTab(doc, tabId, delta) {
  change(doc, () => {
    const tabs = tabsOf(doc);
    const arr = tabs.toArray();
    const i = arr.indexOf(tabId), j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    tabs.delete(i, 1);
    tabs.insert(j, [tabId]);
  });
}

/** Replace the whole workbook (Import, replace) - or add its tabs (Import, add). */
export function loadSnapshot(doc, snap, { replace }) {
  change(doc, () => {
    if (replace) {
      for (const id of tabsOf(doc).toArray()) {
        metaOf(doc).delete(id);
        clearTab(doc, id);
      }
      tabsOf(doc).delete(0, tabsOf(doc).length);
      namesOf(doc).clear();
    }
    for (const t of snap.tabs) writeTab(doc, { ...t, name: uniqueTabName(doc, t.name) });
    for (const [k, v] of Object.entries(snap.names || {})) if (!namesOf(doc).has(k)) namesOf(doc).set(k, v);
  });
}

/**
 * Cells of a block, moved by (dr, dc): formulas re-aimed (relative parts
 * shifted) unless `move` (a cut keeps them pointing where they did).
 * src: [[{v, f(A1), s}]] -> list for writeCells.
 */
export function blockAt(block, r0, c0, dr, dc, move = false) {
  const out = [];
  block.forEach((row, i) => row.forEach((cell, j) => {
    out.push({ r: r0 + i, c: c0 + j, v: cell?.v ?? null, f: cell?.f ? (move ? cell.f : shiftFormula(cell.f, dr, dc)) : null, s: cell?.s || null, l: cell?.l || null });
  }));
  return out;
}

export function undoManagerFor(doc) {
  const scope = (id) => [rowsOf(doc, id), colsOf(doc, id), cellsOf(doc, id), sizesOf(doc, id), ...EXTRAS.map((k) => extraOf(doc, k, id))];
  const um = new Y.UndoManager([tabsOf(doc), metaOf(doc), namesOf(doc), ...tabsOf(doc).toArray().flatMap(scope)], {
    trackedOrigins: new Set([LOCAL]), captureTimeout: 400,
  });
  const onTabs = () => { for (const id of tabsOf(doc).toArray()) um.addToScope(scope(id)); };
  tabsOf(doc).observe(onTabs);
  return { um, destroy: () => { tabsOf(doc).unobserve(onTabs); um.destroy(); } };
}

export { Y };
