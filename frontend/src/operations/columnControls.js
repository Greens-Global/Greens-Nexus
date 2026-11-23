// Operations: the column controls every table in the module uses (Oct 28 2026
// call with Neil, B5) - show / hide, reorder, sort and filter, the same way
// everywhere, kept per person (opsPrefs.js).
//
// A table's arrangement is its SHAPE:
//   { add: [preset keys], order: [column keys], hidden: [column keys],
//     sort: { key, desc } | null, filters: { columnKey: filter } }
// A filter is one of (the server's ops_reports.filter_rows is the same rule,
// so an export or a memorized report comes out exactly as it was on screen):
//   { q: 'ada, bea' }          text that contains any of the words
//   { min, max }               a number, in the column's own units (cents for
//                              money), or a date as YYYY-MM-DD
//   { values: ['Rented'] }     one of these exact values
import { NUMERIC_TYPES, cellText, sortRows } from './reportFormat';

const MAX_KEYS = 80;
const keyList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_KEYS) : []);

export const blankShape = () => ({ add: [], order: [], hidden: [], sort: null, filters: {} });

/** Whatever was stored (or nothing) as a shape the screen can trust. */
export function cleanShape(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const sort = s.sort && typeof s.sort === 'object' && s.sort.key ? { key: String(s.sort.key), desc: !!s.sort.desc } : null;
  const filters = {};
  Object.entries(s.filters && typeof s.filters === 'object' ? s.filters : {}).forEach(([k, f]) => {
    const clean = cleanFilter(f);
    if (clean) filters[k] = clean;
  });
  return { add: keyList(s.add), order: keyList(s.order), hidden: keyList(s.hidden), sort, filters };
}

/** A filter with nothing in it is no filter (null). */
export function cleanFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  const q = String(f.q || '').trim();
  if (q) out.q = q.slice(0, 200);
  ['min', 'max'].forEach((k) => {
    if (f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== '') out[k] = f[k];
  });
  if (Array.isArray(f.values) && f.values.length) out.values = f.values.map(String).slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export const isShaped = (shape) => !!(shape.add.length || shape.order.length || shape.hidden.length || shape.sort
  || Object.keys(shape.filters).length);

/** The columns to draw, in the person's order, without the hidden ones. A
 *  column the order does not know (new in a release) lands after the arranged
 *  ones; hiding everything is not possible - the first column stays. */
export function arrange(columns, shape) {
  const by = new Map(columns.map((c) => [c.key, c]));
  const ordered = [...shape.order.filter((k) => by.has(k)).map((k) => by.get(k)),
    ...columns.filter((c) => !shape.order.includes(c.key))];
  const hidden = new Set(shape.hidden);
  const shown = ordered.filter((c) => !hidden.has(c.key));
  return shown.length ? shown : ordered.slice(0, 1);
}

/** Every column in the person's order, hidden ones included (the Columns list). */
export function ordered(columns, shape) {
  const by = new Map(columns.map((c) => [c.key, c]));
  return [...shape.order.filter((k) => by.has(k)).map((k) => by.get(k)), ...columns.filter((c) => !shape.order.includes(c.key))];
}

const raw = (row, col) => (col.value ? col.value(row) : row[col.key]);
const num = (v) => { const n = Number(v); return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n; };

/** Does one row pass one column's filter? */
export function passes(row, col, f) {
  const v = raw(row, col);
  if (f.values?.length && !f.values.includes(v === null || v === undefined ? '' : String(v))) return false;
  if (f.q) {
    const words = f.q.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
    const text = String(v ?? '').toLowerCase();
    const shown = cellText(v, col.type).toLowerCase();
    if (words.length && !words.some((w) => text.includes(w) || shown.includes(w))) return false;
  }
  if (col.type === 'date') {
    const day = v ? String(v).slice(0, 10) : '';
    if (f.min && (!day || day < String(f.min).slice(0, 10))) return false;
    if (f.max && (!day || day > String(f.max).slice(0, 10))) return false;
    return true;
  }
  const n = num(v);
  if (f.min !== undefined && (n === null || n < Number(f.min))) return false;
  if (f.max !== undefined && (n === null || n > Number(f.max))) return false;
  return true;
}

export function filterRows(rows, columns, filters) {
  const tests = Object.entries(filters || {})
    .map(([k, f]) => [columns.find((c) => c.key === k), cleanFilter(f)])
    .filter(([c, f]) => c && f);
  if (!tests.length) return rows;
  return rows.filter((r) => tests.every(([c, f]) => passes(r, c, f)));
}

/** Rows filtered and sorted by the shape (columns may carry `value(row)` for
 *  tables whose cells are not plain values). */
export function shapeRows(rows, columns, shape) {
  const hit = filterRows(rows, columns, shape.filters);
  const col = shape.sort && columns.find((c) => c.key === shape.sort.key);
  if (!col) return hit;
  if (!col.value) return sortRows(hit, col.key, shape.sort.desc, col.type);
  const keyed = hit.map((r) => ({ r, v: col.value(r) }));
  const sorted = sortRows(keyed.map((x, i) => ({ i, v: x.v })), 'v', shape.sort.desc, col.type);
  return sorted.map((x) => keyed[x.i].r);
}

/** unsorted -> ascending -> descending -> unsorted (the house header click). */
export const nextSort = (sort, key) => (sort?.key !== key ? { key, desc: false } : sort.desc ? null : { key, desc: true });

/** The distinct values a column holds, when there are few enough to tick. */
export function distinctValues(rows, col, cap = 25) {
  if (NUMERIC_TYPES.has(col.type) || col.type === 'date') return null;
  const seen = new Set();
  for (const r of rows) {
    const v = raw(r, col);
    seen.add(v === null || v === undefined ? '' : String(v));
    if (seen.size > cap) return null;
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'en-US', { numeric: true }));
}

/** In words, for a memorized report's line and the filter chips' titles. */
export function filterWords(col, f) {
  const parts = [];
  const fmt = (v) => (col.type === 'money' ? cellText(Number(v), 'money') : col.type === 'date' ? cellText(v, 'date') : String(v));
  if (f.values?.length) parts.push(f.values.map((v) => v || '(Blank)').join(', '));
  if (f.q) parts.push(`contains ${f.q}`);
  if (f.min !== undefined && f.max !== undefined) parts.push(`${fmt(f.min)} to ${fmt(f.max)}`);
  else if (f.min !== undefined) parts.push(`at least ${fmt(f.min)}`);
  else if (f.max !== undefined) parts.push(`at most ${fmt(f.max)}`);
  return `${col.label} ${parts.join(', ')}`;
}

/** The shape as report options for the server (ops_reports.SHAPE_OPTIONS),
 *  so an export, a schedule and a memorized report match the screen. The
 *  server orders and hides by the same rule as `arrange`. */
export function shapeOptions(shape) {
  const out = {};
  if (shape.add.length) out.addColumns = shape.add.join(',');
  if (shape.order.length) out.showColumns = shape.order.join(',');
  if (shape.hidden.length) out.hideColumns = shape.hidden.join(',');
  if (shape.sort) out.sortBy = `${shape.sort.key}:${shape.sort.desc ? 'desc' : 'asc'}`;
  if (Object.keys(shape.filters).length) out.filters = JSON.stringify(shape.filters);
  return out;
}

/** The other way: a schedule's or an old link's options back into a shape. */
export function shapeFromOptions(options) {
  const o = options || {};
  const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const filters = (() => { try { return o.filters ? JSON.parse(o.filters) : {}; } catch { return {}; } })();
  const [key, way] = String(o.sortBy || '').split(':');
  return cleanShape({ add: split(o.addColumns), order: split(o.showColumns), hidden: split(o.hideColumns),
    sort: key ? { key, desc: way === 'desc' } : null, filters });
}

/** Moves one key in a list of keys. */
export function move(keys, key, by) {
  const i = keys.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  const next = [...keys];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
