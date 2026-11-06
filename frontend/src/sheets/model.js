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
const MAX_TABS = 200, MAX_STR = 50000;

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

function writeTab(doc, t, at) {
  const tabs = tabsOf(doc);
  tabs.insert(at == null ? tabs.length : at, [t.id]);
  metaOf(doc).set(t.id, { name: t.name, color: t.color || '', frozenRows: t.frozenRows | 0, frozenCols: t.frozenCols | 0 });
  const rows = rowsOf(doc, t.id), cols = colsOf(doc, t.id), cells = cellsOf(doc, t.id), sizes = sizesOf(doc, t.id);
  if (rows.length) rows.delete(0, rows.length);
  if (cols.length) cols.delete(0, cols.length);
  cells.clear(); sizes.clear();
  rows.push(t.rows);
  cols.push(t.cols);
  for (const [k, v] of Object.entries(t.cells || {})) cells.set(k, v);
  for (const [k, v] of Object.entries(t.sizes || {})) sizes.set(k, v);
}

/** A shared document built from a stored snapshot. */
export function seedSheetDoc(snapshot) {
  const doc = new Y.Doc();
  const snap = snapshot?.type === 'nexus-sheet' && snapshot.tabs?.length ? snapshot : newSheetContent();
  doc.transact(() => { for (const t of snap.tabs) writeTab(doc, t); });
  return doc;
}

/** The workbook as a snapshot (what the server stores). Cells of deleted rows or columns are left out. */
export function snapshotOf(doc) {
  const meta = metaOf(doc);
  return {
    type: 'nexus-sheet', v: 1,
    tabs: tabsOf(doc).toArray().filter((id) => meta.has(id)).map((id) => {
      const m = meta.get(id) || {};
      const rows = rowsOf(doc, id).toArray(), cols = colsOf(doc, id).toArray();
      const rs = new Set(rows), cs = new Set(cols);
      const cells = {};
      cellsOf(doc, id).forEach((v, k) => { const [r, c] = k.split('.'); if (rs.has(r) && cs.has(c)) cells[k] = v; });
      const sizes = {};
      sizesOf(doc, id).forEach((v, k) => { if (rs.has(k) || cs.has(k)) sizes[k] = v; });
      return { id, name: m.name || 'Sheet', color: m.color || '', frozenRows: m.frozenRows | 0, frozenCols: m.frozenCols | 0, rows, cols, cells, sizes };
    }),
  };
}

// ── is a stored state safe to put on screen? ─────────────────────────────
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const NF = new Set(['', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'text']);
const HA = new Set(['left', 'center', 'right']);
const plain = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

export function validStyle(s) {
  if (s == null) return true;
  if (!plain(s)) return false;
  for (const [k, v] of Object.entries(s)) {
    if (['b', 'i', 'u', 'st', 'wrap'].includes(k)) { if (typeof v !== 'boolean') return false; }
    else if (k === 'fc' || k === 'bg') { if (typeof v !== 'string' || !COLOR_RE.test(v)) return false; }
    else if (k === 'ha') { if (!HA.has(v)) return false; }
    else if (k === 'nf') { if (!NF.has(v)) return false; }
    else if (k === 'd') { if (!Number.isInteger(v) || v < 0 || v > 10) return false; }
    else return false;
  }
  return true;
}
export function validCell(c) {
  if (!plain(c)) return false;
  for (const k of Object.keys(c)) if (!['v', 'f', 's'].includes(k)) return false;
  const { v, f } = c;
  if (!(v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_STR))) return false;
  if (f != null && (typeof f !== 'string' || f[0] !== '=' || f.length > MAX_STR)) return false;
  return validStyle(c.s);
}

/** Throws when the shared document is not a well-formed workbook. */
export function validateSheetDoc(doc) {
  const fail = (why) => { throw new Error(`Not a sheet: ${why}`); };
  const tabs = tabsOf(doc).toArray();
  if (!tabs.length || tabs.length > MAX_TABS) fail('tabs');
  const meta = metaOf(doc);
  let total = 0;
  for (const id of tabs) {
    if (typeof id !== 'string' || !ID_RE.test(id)) fail('tab id');
    const m = meta.get(id);
    if (!plain(m) || typeof m.name !== 'string' || !m.name || m.name.length > 100) fail('tab name');
    if (m.color && (typeof m.color !== 'string' || !COLOR_RE.test(m.color))) fail('tab color');
    for (const k of ['frozenRows', 'frozenCols']) if (m[k] != null && (!Number.isInteger(m[k]) || m[k] < 0 || m[k] > 100)) fail('freeze');
    const rows = rowsOf(doc, id).toArray(), cols = colsOf(doc, id).toArray();
    if (!rows.length || rows.length > MAX_ROWS || !cols.length || cols.length > MAX_COLS) fail('size');
    if (!rows.every((x) => typeof x === 'string' && ID_RE.test(x)) || !cols.every((x) => typeof x === 'string' && ID_RE.test(x))) fail('row or column id');
    const cells = cellsOf(doc, id);
    total += cells.size;
    if (total > MAX_CELLS) fail('too many cells');
    cells.forEach((v, k) => { if (k.length > 81 || !validCell(v)) fail('cell'); });
    sizesOf(doc, id).forEach((v) => { if (typeof v !== 'number' || !(v >= 4 && v <= 2000)) fail('size value'); });
  }
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
  const tabs = tabsOf(doc).toArray().filter((id) => meta.has(id)).map((id) => {
    // A live edit arrives after the mount check: read every field defensively.
    const m = plain(meta.get(id)) ? meta.get(id) : {};
    const frozen = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(100, v)) : 0);
    return { id, name: typeof m.name === 'string' && m.name ? m.name.slice(0, 100) : 'Sheet',
      color: typeof m.color === 'string' && COLOR_RE.test(m.color) ? m.color : '',
      frozenRows: frozen(m.frozenRows), frozenCols: frozen(m.frozenCols),
      rows: rowsOf(doc, id).toArray().map(String), cols: colsOf(doc, id).toArray().map(String), cells: cellsOf(doc, id), sizes: sizesOf(doc, id) };
  });
  return makeCtx(tabs, grow ? (tab, axis, n) => {
    const fresh = ids(n);
    (axis === 'rows' ? rowsOf(doc, tab.id) : colsOf(doc, tab.id)).push(fresh);
    return fresh;
  } : null);
}

/** The same view over plain tabs (cells/sizes as Map-like or plain objects). */
const checked = new WeakMap();
/** validCell, remembered per stored object (a Y.Map hands back the same object until it changes). */
function okCell(x) {
  if (typeof x !== 'object') return false;
  let ok = checked.get(x);
  if (ok === undefined) { ok = validCell(x); checked.set(x, ok); }
  return ok;
}

export function makeCtx(tabs, grow) {
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
      return x && okCell(x) ? x : undefined;
    },
    size: (tab, id, dflt) => { const v = get(tab.sizes, id); return typeof v === 'number' && v >= 4 && v <= 2000 ? v : dflt; },
  };
}

/** The A1 text of a stored cell's formula. */
export const formulaText = (ctx, tabId, f) => decodeFormula(f, ctx, tabId);

// ── changes (each one LOCAL transaction) ─────────────────────────────────
export const change = (doc, fn) => doc.transact(fn, LOCAL);
const sameObj = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function putCell(map, key, next) {
  const clean = {};
  if (next.v != null && next.v !== '') clean.v = next.v;
  if (next.f) clean.f = next.f;
  if (next.s && Object.keys(next.s).length) clean.s = next.s;
  if (!Object.keys(clean).length) { if (map.has(key)) map.delete(key); return; }
  if (!sameObj(map.get(key), clean)) map.set(key, clean);
}

/**
 * Write cells: [{r, c, v?, f?(A1 text), s?, keepStyle}] on one tab. A
 * formula is encoded here (and may grow the tab); v/f replace the content,
 * s replaces the style when given.
 */
export function writeCells(doc, tabId, list) {
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    if (!tab) return;
    const map = cellsOf(doc, tabId);
    for (const it of list) {
      const key = ctx.rowId(tab, it.r) + '.' + ctx.colId(tab, it.c);
      const cur = map.get(key) || {};
      let f = null;
      if (it.f) { try { f = encodeFormula(it.f, ctx, tabId); } catch { f = it.f; } }
      putCell(map, key, { v: f ? null : it.v, f, s: it.s !== undefined ? it.s : cur.s });
    }
  });
}

/** Put stored cells (formulas already encoded) at positions - a sort moves cells this way. */
export function placeRaw(doc, tabId, list) {
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    for (const it of list) putCell(map, ctx.rowId(tab, it.r) + '.' + ctx.colId(tab, it.c), it.cell || {});
  });
}

/** Merge a style patch into every cell of the range (null removes a key). */
export function styleRange(doc, tabId, { r1, c1, r2, c2 }, patch) {
  change(doc, () => {
    const ctx = buildCtx(doc, { grow: true });
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const key = ctx.rowId(tab, r) + '.' + ctx.colId(tab, c);
        const cur = map.get(key) || {};
        const s = { ...(cur.s || {}) };
        for (const [k, v] of Object.entries(patch)) { if (v == null || v === false || v === '') delete s[k]; else s[k] = v; }
        putCell(map, key, { ...cur, s });
      }
    }
  });
}

/** Clear the content (keep the formatting) of a range. */
export function clearRange(doc, tabId, { r1, c1, r2, c2 }, { formats = false } = {}) {
  change(doc, () => {
    const ctx = buildCtx(doc);
    const tab = ctx.tabById(tabId);
    const map = cellsOf(doc, tabId);
    for (let r = r1; r <= Math.min(r2, tab.rows.length - 1); r += 1) {
      for (let c = c1; c <= Math.min(c2, tab.cols.length - 1); c += 1) {
        const key = tab.rows[r] + '.' + tab.cols[c];
        const cur = map.get(key);
        if (cur) putCell(map, key, formats ? {} : { s: cur.s });
      }
    }
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
    const sizes = sizesOf(doc, tabId);
    for (const id of gone) if (sizes.has(id)) sizes.delete(id);
  });
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

export function addTab(doc, snapshotTab, at) {
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
    const rows = rowsOf(doc, tabId), cols = colsOf(doc, tabId);
    rows.delete(0, rows.length); cols.delete(0, cols.length);
    cellsOf(doc, tabId).clear(); sizesOf(doc, tabId).clear();
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
        const rows = rowsOf(doc, id), cols = colsOf(doc, id);
        rows.delete(0, rows.length); cols.delete(0, cols.length);
        cellsOf(doc, id).clear(); sizesOf(doc, id).clear();
      }
      tabsOf(doc).delete(0, tabsOf(doc).length);
    }
    for (const t of snap.tabs) writeTab(doc, { ...t, name: uniqueTabName(doc, t.name) });
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
    out.push({ r: r0 + i, c: c0 + j, v: cell?.v ?? null, f: cell?.f ? (move ? cell.f : shiftFormula(cell.f, dr, dc)) : null, s: cell?.s || null });
  }));
  return out;
}

export function undoManagerFor(doc) {
  const scope = (id) => [rowsOf(doc, id), colsOf(doc, id), cellsOf(doc, id), sizesOf(doc, id)];
  const um = new Y.UndoManager([tabsOf(doc), metaOf(doc), ...tabsOf(doc).toArray().flatMap(scope)], {
    trackedOrigins: new Set([LOCAL]), captureTimeout: 400,
  });
  const onTabs = () => { for (const id of tabsOf(doc).toArray()) um.addToScope(scope(id)); };
  tabsOf(doc).observe(onTabs);
  return { um, destroy: () => { tabsOf(doc).unobserve(onTabs); um.destroy(); } };
}

export { Y };
