// Sheets formulas: the values a formula works with - numbers, strings,
// booleans, null (blank), an Err, or a Rng (a range argument).
import { parseDateText, formatGeneral } from '../format.js';

export class Err {
  constructor(code, note = '') { this.code = code; this.note = note; }
  toString() { return this.code; }
}
export const isErr = (x) => x instanceof Err;
export const err = (code, note) => new Err(code, note);

export class Rng {
  constructor(eng, tab, r1, c1, r2, c2) {
    Object.assign(this, { eng, tab, r1, c1, r2, c2 });
    this.h = r2 - r1 + 1;
    this.w = c2 - c1 + 1;
  }
  at(i, j) { return this.eng.cellValue(this.tab, this.r1 + i, this.c1 + j); }
  /** 2D values, cut to what the tab really has (anything past it is blank). */
  get rows() {
    if (this._rows) return this._rows;
    const hh = Math.min(this.h, Math.max(0, this.tab.rows.length - this.r1));
    const ww = Math.min(this.w, Math.max(0, this.tab.cols.length - this.c1));
    const out = [];
    for (let i = 0; i < hh; i += 1) {
      const row = [];
      for (let j = 0; j < ww; j += 1) row.push(this.at(i, j));
      out.push(row);
    }
    this._rows = out;
    return out;
  }
  flat() { return this.rows.flat(); }
}

/** Largest / smallest of a list by a loop - spreading 100,000 values into Math.max overflows the stack. */
export function maxOf(list, start = -Infinity) { let m = start; for (const x of list) if (x > m) m = x; return m; }
export function minOf(list, start = Infinity) { let m = start; for (const x of list) if (x < m) m = x; return m; }

/** A worked-out array (FILTER, SORT, A1:A9*2...): a range with no cells behind it. */
export class Arr extends Rng {
  constructor(rows) {
    const h = rows.length;
    let w = 0;
    for (const r of rows) if (r.length > w) w = r.length;
    super(null, null, 0, 0, h - 1, w - 1);
    this._rows = rows.map((r) => (r.length === w ? r : [...r, ...Array(w - r.length).fill(null)]));
  }
  at(i, j) { return this._rows[i]?.[j] ?? null; }
}
/** A range or array of more than one cell (it spills, operators broadcast over it). */
export const isMulti = (x) => x instanceof Rng && (x.h > 1 || x.w > 1);

export function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isErr(v)) return v;
  const t = String(v).trim();
  if (t === '') return 0;
  const n = Number(t.replace(/,/g, ''));
  if (Number.isFinite(n)) return n;
  const pct = t.match(/^(-?[\d.,]+)%$/);
  if (pct) { const p = Number(pct[1].replace(/,/g, '')); if (Number.isFinite(p)) return p / 100; }
  const dt = parseDateText(t);
  return dt ? dt.v : err('#VALUE!');
}
export function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatGeneral(v);
  return String(v);
}
export function toBool(v) {
  if (isErr(v)) return v;
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = String(v).toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  return err('#VALUE!');
}

const TYPE_RANK = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
/** Excel's order: numbers < text < booleans; text ignores case. */
export function compare(a, b) {
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = TYPE_RANK(a), rb = TYPE_RANK(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

