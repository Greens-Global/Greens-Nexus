// Sheets formulas: the functions. Each takes (args, env, eng) - args already
// worked out (a range stays a Rng) - and returns a value or an Err.
import { isErr, err, Rng, toNum, toStr, toBool, compare } from './values.js';
import { serialFromYMD, ymdFromSerial, hmsFromSerial, serialFromDate, textFormat } from '../format.js';

const NA = () => err('#N/A');
const VALUE = () => err('#VALUE!');
const NUM = () => err('#NUM!');

/** Every value in the arguments, ranges flattened. */
function* each(args) {
  for (const a of args) {
    if (a instanceof Rng) yield* a.flat().map((v) => ({ v, inRange: true }));
    else yield { v: a, inRange: false };
  }
}
/** The numbers SUM-like functions count: numbers in ranges, anything numeric typed as an argument. */
function nums(args) {
  const out = [];
  for (const { v, inRange } of each(args)) {
    if (isErr(v)) throw v;
    if (inRange) { if (typeof v === 'number') out.push(v); continue; }
    if (v == null) continue;
    const n = toNum(v);
    if (isErr(n)) throw n;
    out.push(n);
  }
  return out;
}
const num = (v) => { const n = toNum(v instanceof Rng ? v.at(0, 0) : v); if (isErr(n)) throw n; return n; };
const str = (v) => { const x = v instanceof Rng ? v.at(0, 0) : v; if (isErr(x)) throw x; return toStr(x); };
const bool = (v) => { const b = toBool(v instanceof Rng ? v.at(0, 0) : v); if (isErr(b)) throw b; return b; };
const int = (v) => Math.trunc(num(v));
const opt = (v, d) => (v == null ? d : v);
const range = (v) => { if (!(v instanceof Rng)) throw VALUE(); return v; };
/** A range or a single value as a 2D array. */
const grid = (v) => (v instanceof Rng ? v.rows : [[v]]);

function shift(n, d) {
  const s = String(n);
  return s.includes('e') ? n * 10 ** d : Number(`${s}e${d}`);
}
function roundTo(x, d, how) {
  const sign = x < 0 ? -1 : 1;
  const a = shift(Math.abs(x), d);
  const r = how === 'up' ? Math.ceil(a - 1e-9) : how === 'down' ? Math.floor(a + 1e-9) : Math.round(a + 1e-9);
  return sign * shift(r, -d);
}

// ── criteria (SUMIF, COUNTIFS...) ────────────────────────────────────────
function wildcard(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '~' && (pat[i + 1] === '*' || pat[i + 1] === '?')) { re += '\\' + pat[i + 1]; i += 1; }
    else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
export function criteria(crit) {
  if (isErr(crit)) throw crit;
  if (typeof crit === 'number' || typeof crit === 'boolean') return (v) => v === crit;
  const m = String(crit ?? '').match(/^(<=|>=|<>|=|<|>)?([\s\S]*)$/);
  const op = m[1] || '=';
  const raw = m[2];
  const n = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const b = /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : null;
  if (n != null || b != null) {
    const want = n != null ? n : b;
    return (v) => {
      const same = typeof v === typeof want;
      if (!same) return op === '<>';
      const c = compare(v, want);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    };
  }
  if (op === '=' || op === '<>') {
    if (raw === '') return op === '=' ? (v) => v == null || v === '' : (v) => !(v == null || v === '');
    const re = wildcard(raw);
    return op === '=' ? (v) => typeof v === 'string' && re.test(v) : (v) => !(typeof v === 'string' && re.test(v));
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const c = compare(v, raw);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
}
/** The positions (i, j) of rng where every (range, criterion) pair matches. */
function matching(pairs) {
  const [first] = pairs;
  const out = [];
  for (const [r] of pairs) if (r.h !== first[0].h || r.w !== first[0].w) throw VALUE();
  for (let i = 0; i < first[0].h; i += 1) {
    for (let j = 0; j < first[0].w; j += 1) {
      if (pairs.every(([r, test]) => test(r.at(i, j)))) out.push([i, j]);
    }
  }
  return out;
}
function ifs(sumRng, args, start) {
  const pairs = [];
  for (let k = start; k < args.length; k += 2) pairs.push([range(args[k]), criteria(args[k + 1] instanceof Rng ? args[k + 1].at(0, 0) : args[k + 1])]);
  if (!pairs.length) throw VALUE();
  const target = sumRng || pairs[0][0];
  return matching(pairs).map(([i, j]) => target.at(i, j)).filter((v) => typeof v === 'number');
}

// ── lookups ───────────────────────────────────────────────────────────────
const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? wildcard(b).test(a) : compare(a, b) === 0 && a != null);
/** Index of key in a 1D list: exact (0), or the largest <= key (1, sorted ascending), or smallest >= key (-1). */
function find(list, key, mode) {
  if (mode === 0) { const i = list.findIndex((v) => same(v, key)); return i; }
  let best = -1;
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i];
    if (v == null) continue;
    const c = compare(v, key);
    if (mode === 1) { if (c <= 0) best = i; else break; }
    else if (c >= 0) best = i; else break;
  }
  return best;
}
const col = (rng, j) => Array.from({ length: rng.h }, (_, i) => rng.at(i, j));
const row = (rng, i) => Array.from({ length: rng.w }, (_, j) => rng.at(i, j));

// ── dates ────────────────────────────────────────────────────────────────
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function dateOf(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, 1));
  return serialFromYMD(t.getUTCFullYear(), t.getUTCMonth() + 1, 1) + (d - 1);
}
function addMonths(serial, months, endOfMonth) {
  const { y, m, d } = ymdFromSerial(serial);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const ny = t.getUTCFullYear(), nm = t.getUTCMonth() + 1;
  const dim = daysInMonth(ny, nm);
  return serialFromYMD(ny, nm, endOfMonth ? dim : Math.min(d, dim));
}
const weekday = (serial) => new Date(Date.UTC(ymdFromSerial(serial).y, ymdFromSerial(serial).m - 1, ymdFromSerial(serial).d)).getUTCDay();

// ── finance ──────────────────────────────────────────────────────────────
function pmt(rate, nper, pv, fv = 0, type = 0) {
  if (rate === 0) return -(pv + fv) / nper;
  const f = (1 + rate) ** nper;
  return -(rate * (pv * f + fv)) / ((1 + rate * type) * (f - 1));
}
function fvOf(rate, nper, p, pv = 0, type = 0) {
  if (rate === 0) return -(pv + p * nper);
  const f = (1 + rate) ** nper;
  return -(pv * f + (p * (1 + rate * type) * (f - 1)) / rate);
}

export const FN = {
  // math
  SUM: (a) => nums(a).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => { const n = nums(a); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err('#DIV/0!'); },
  MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => { let k = 0; for (const { v, inRange } of each(a)) if (typeof v === 'number' || (!inRange && v != null && !isErr(toNum(v)) && typeof v !== 'boolean')) k += 1; return k; },
  COUNTA: (a) => { let k = 0; for (const { v } of each(a)) if (v != null) k += 1; return k; },
  COUNTBLANK: (a) => { const r = range(a[0]); let filled = 0; for (const v of r.flat()) if (v != null && v !== '') filled += 1; return r.h * r.w - filled; },
  PRODUCT: (a) => nums(a).reduce((s, x) => s * x, 1),
  ROUND: (a) => roundTo(num(a[0]), int(opt(a[1], 0))),
  ROUNDUP: (a) => roundTo(num(a[0]), int(opt(a[1], 0)), 'up'),
  ROUNDDOWN: (a) => roundTo(num(a[0]), int(opt(a[1], 0)), 'down'),
  INT: (a) => Math.floor(num(a[0])),
  ABS: (a) => Math.abs(num(a[0])),
  SIGN: (a) => Math.sign(num(a[0])),
  MOD: (a) => { const n = num(a[0]), d = num(a[1]); return d === 0 ? err('#DIV/0!') : n - d * Math.floor(n / d); },
  POWER: (a) => { const p = num(a[0]) ** num(a[1]); return Number.isFinite(p) ? p : NUM(); },
  SQRT: (a) => { const n = num(a[0]); return n < 0 ? NUM() : Math.sqrt(n); },
  PI: () => Math.PI,
  CEILING: (a) => { const x = num(a[0]), s = num(opt(a[1], 1)); return s === 0 ? 0 : Math.ceil(x / s - 1e-12) * s; },
  FLOOR: (a) => { const x = num(a[0]), s = num(opt(a[1], 1)); return s === 0 ? err('#DIV/0!') : Math.floor(x / s + 1e-12) * s; },
  MEDIAN: (a) => {
    const n = nums(a).sort((x, y) => x - y);
    if (!n.length) return NUM();
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  SUMPRODUCT: (a) => {
    const gs = a.map(grid);
    const h = gs[0].length, w = gs[0][0]?.length || 0;
    if (gs.some((g) => g.length !== h || (g[0]?.length || 0) !== w)) return VALUE();
    let s = 0;
    for (let i = 0; i < h; i += 1) for (let j = 0; j < w; j += 1) s += gs.reduce((p, g) => p * (typeof g[i][j] === 'number' ? g[i][j] : 0), 1);
    return s;
  },
  SUMIF: (a) => ifs(a[2] != null ? range(a[2]) : null, [a[0], a[1]], 0).reduce((s, x) => s + x, 0),
  SUMIFS: (a) => ifs(range(a[0]), a, 1).reduce((s, x) => s + x, 0),
  COUNTIF: (a) => matching([[range(a[0]), criteria(a[1] instanceof Rng ? a[1].at(0, 0) : a[1])]]).length,
  COUNTIFS: (a) => {
    const pairs = [];
    for (let k = 0; k < a.length; k += 2) pairs.push([range(a[k]), criteria(a[k + 1] instanceof Rng ? a[k + 1].at(0, 0) : a[k + 1])]);
    return matching(pairs).length;
  },
  AVERAGEIF: (a) => { const n = ifs(a[2] != null ? range(a[2]) : null, [a[0], a[1]], 0); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err('#DIV/0!'); },
  AVERAGEIFS: (a) => { const n = ifs(range(a[0]), a, 1); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err('#DIV/0!'); },
  MAXIFS: (a) => { const n = ifs(range(a[0]), a, 1); return n.length ? Math.max(...n) : 0; },
  MINIFS: (a) => { const n = ifs(range(a[0]), a, 1); return n.length ? Math.min(...n) : 0; },
  RAND: () => Math.random(),
  RANDBETWEEN: (a) => { const lo = Math.ceil(num(a[0])), hi = Math.floor(num(a[1])); return hi < lo ? NUM() : lo + Math.floor(Math.random() * (hi - lo + 1)); },

  // logic (IF, IFERROR and IFNA are worked out lazily in eval.js)
  IFS: (a) => { for (let k = 0; k < a.length; k += 2) if (bool(a[k])) return a[k + 1] instanceof Rng ? a[k + 1].at(0, 0) : a[k + 1]; return NA(); },
  AND: (a) => { const bs = logicals(a); return bs.length ? bs.every(Boolean) : VALUE(); },
  OR: (a) => { const bs = logicals(a); return bs.length ? bs.some(Boolean) : VALUE(); },
  XOR: (a) => { const bs = logicals(a); return bs.length ? bs.filter(Boolean).length % 2 === 1 : VALUE(); },
  NOT: (a) => !bool(a[0]),
  TRUE: () => true,
  FALSE: () => false,
  SWITCH: (a) => {
    const v = a[0] instanceof Rng ? a[0].at(0, 0) : a[0];
    if (isErr(v)) return v;
    let k = 1;
    for (; k + 1 < a.length; k += 2) if (compare(v, a[k] instanceof Rng ? a[k].at(0, 0) : a[k]) === 0) return a[k + 1];
    return k < a.length ? a[k] : NA();
  },

  // text
  CONCAT: (a) => { let s = ''; for (const { v } of each(a)) { if (isErr(v)) return v; s += toStr(v); } return s; },
  CONCATENATE: (a) => a.map(str).join(''),
  TEXTJOIN: (a) => {
    const delim = str(a[0]), skip = bool(a[1]);
    const parts = [];
    for (const { v } of each(a.slice(2))) { if (isErr(v)) return v; const s = toStr(v); if (!skip || s !== '') parts.push(s); }
    return parts.join(delim);
  },
  LEFT: (a) => { const n = int(opt(a[1], 1)); return n < 0 ? VALUE() : str(a[0]).slice(0, n); },
  RIGHT: (a) => { const n = int(opt(a[1], 1)); const s = str(a[0]); return n < 0 ? VALUE() : n === 0 ? '' : s.slice(-n); },
  MID: (a) => { const s = str(a[0]), st = int(a[1]), n = int(a[2]); return st < 1 || n < 0 ? VALUE() : s.substr(st - 1, n); },
  LEN: (a) => str(a[0]).length,
  UPPER: (a) => str(a[0]).toUpperCase(),
  LOWER: (a) => str(a[0]).toLowerCase(),
  PROPER: (a) => str(a[0]).toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, p, c) => p + c.toUpperCase()),
  TRIM: (a) => str(a[0]).replace(/ +/g, ' ').trim(),
  SUBSTITUTE: (a) => {
    const s = str(a[0]), from = str(a[1]), to = str(a[2]);
    if (!from) return s;
    if (a[3] == null) return s.split(from).join(to);
    const nth = int(a[3]);
    let idx = -1;
    for (let k = 0; k < nth; k += 1) { idx = s.indexOf(from, idx + 1); if (idx < 0) return s; }
    return s.slice(0, idx) + to + s.slice(idx + from.length);
  },
  REPLACE: (a) => { const s = str(a[0]), st = int(a[1]), n = int(a[2]); return st < 1 || n < 0 ? VALUE() : s.slice(0, st - 1) + str(a[3]) + s.slice(st - 1 + n); },
  FIND: (a) => { const i = str(a[1]).indexOf(str(a[0]), int(opt(a[2], 1)) - 1); return i < 0 ? VALUE() : i + 1; },
  SEARCH: (a) => {
    const hay = str(a[1]), start = int(opt(a[2], 1)) - 1;
    const re = new RegExp(wildcard(str(a[0])).source.slice(1, -1), 'i');
    const m = re.exec(hay.slice(start));
    return m ? m.index + start + 1 : VALUE();
  },
  TEXT: (a) => textFormat(typeof (a[0] instanceof Rng ? a[0].at(0, 0) : a[0]) === 'string' ? str(a[0]) : num(a[0]), str(a[1])),
  VALUE: (a) => { const v = a[0] instanceof Rng ? a[0].at(0, 0) : a[0]; return typeof v === 'number' ? v : toNum(String(v ?? '').replace(/^\$/, '')); },
  REPT: (a) => { const n = int(a[1]); return n < 0 ? VALUE() : str(a[0]).repeat(n); },
  EXACT: (a) => str(a[0]) === str(a[1]),

  // lookup
  VLOOKUP: (a) => {
    const key = a[0] instanceof Rng ? a[0].at(0, 0) : a[0], rng = range(a[1]), k = int(a[2]);
    if (k < 1 || k > rng.w) return err('#REF!');
    const i = find(col(rng, 0), key, opt(a[3], true) === false || a[3] === 0 ? 0 : 1);
    return i < 0 ? NA() : rng.at(i, k - 1);
  },
  HLOOKUP: (a) => {
    const key = a[0] instanceof Rng ? a[0].at(0, 0) : a[0], rng = range(a[1]), k = int(a[2]);
    if (k < 1 || k > rng.h) return err('#REF!');
    const j = find(row(rng, 0), key, opt(a[3], true) === false || a[3] === 0 ? 0 : 1);
    return j < 0 ? NA() : rng.at(k - 1, j);
  },
  XLOOKUP: (a) => {
    const key = a[0] instanceof Rng ? a[0].at(0, 0) : a[0], look = range(a[1]), ret = range(a[2]);
    const vertical = look.w === 1;
    const list = vertical ? col(look, 0) : row(look, 0);
    const mode = int(opt(a[4], 0)), back = int(opt(a[5], 1)) === -1;
    let i;
    const order = list.map((_, k) => (back ? list.length - 1 - k : k));
    if (mode === 0 || mode === 2) i = order.find((k) => (mode === 2 ? same(list[k], key) : compare(list[k], key) === 0 && list[k] != null)) ?? -1;
    else {
      let best = -1;
      for (const k of order) {
        const v = list[k];
        if (v == null || typeof v !== typeof key) continue;
        const c = compare(v, key);
        if (c === 0) { best = k; break; }
        if (mode === -1 && c < 0 && (best < 0 || compare(v, list[best]) > 0)) best = k;
        if (mode === 1 && c > 0 && (best < 0 || compare(v, list[best]) < 0)) best = k;
      }
      i = best;
    }
    if (i < 0) return a[3] != null ? a[3] : NA();
    return vertical ? ret.at(i, 0) : ret.at(0, i);
  },
  INDEX: (a) => {
    const rng = range(a[0]);
    let r = int(opt(a[1], 1)), c = int(opt(a[2], 1));
    if (rng.h === 1 && a[2] == null) { c = r; r = 1; }
    if (r < 1 || c < 1 || r > rng.h || c > rng.w) return err('#REF!');
    return rng.at(r - 1, c - 1);
  },
  MATCH: (a) => {
    const key = a[0] instanceof Rng ? a[0].at(0, 0) : a[0], rng = range(a[1]);
    const list = rng.w === 1 ? col(rng, 0) : row(rng, 0);
    const i = find(list, key, int(opt(a[2], 1)));
    return i < 0 ? NA() : i + 1;
  },
  CHOOSE: (a) => { const i = int(a[0]); return i < 1 || i >= a.length ? VALUE() : a[i]; },
  ROW: (a, env) => (a[0] instanceof Rng ? a[0].r1 + 1 : env.r + 1),
  COLUMN: (a, env) => (a[0] instanceof Rng ? a[0].c1 + 1 : env.c + 1),
  ROWS: (a) => (a[0] instanceof Rng ? a[0].h : 1),
  COLUMNS: (a) => (a[0] instanceof Rng ? a[0].w : 1),

  // dates
  TODAY: () => Math.floor(serialFromDate(new Date())),
  NOW: () => serialFromDate(new Date()),
  DATE: (a) => { const y = int(a[0]), m = int(a[1]), d = int(a[2]); return dateOf(y < 1900 ? y + 1900 : y, m, d); },
  YEAR: (a) => ymdFromSerial(num(a[0])).y,
  MONTH: (a) => ymdFromSerial(num(a[0])).m,
  DAY: (a) => ymdFromSerial(num(a[0])).d,
  HOUR: (a) => hmsFromSerial(num(a[0])).h,
  MINUTE: (a) => hmsFromSerial(num(a[0])).mi,
  WEEKDAY: (a) => {
    const w = weekday(num(a[0])), type = int(opt(a[1], 1));
    if (type === 1) return w + 1;
    if (type === 2) return ((w + 6) % 7) + 1;
    if (type === 3) return (w + 6) % 7;
    return NUM();
  },
  EDATE: (a) => addMonths(num(a[0]), int(a[1]), false),
  EOMONTH: (a) => addMonths(num(a[0]), int(a[1]), true),
  DAYS: (a) => Math.floor(num(a[0])) - Math.floor(num(a[1])),
  NETWORKDAYS: (a) => {
    let s = Math.floor(num(a[0])), e = Math.floor(num(a[1]));
    const sign = e < s ? -1 : 1;
    if (sign < 0) [s, e] = [e, s];
    const off = new Set(a[2] != null ? nums([a[2]]).map(Math.floor) : []);
    let k = 0;
    for (let d = s; d <= e; d += 1) { const w = weekday(d); if (w !== 0 && w !== 6 && !off.has(d)) k += 1; }
    return sign * k;
  },
  DATEDIF: (a) => {
    const s = Math.floor(num(a[0])), e = Math.floor(num(a[1])), unit = str(a[2]).toUpperCase();
    if (e < s) return NUM();
    const A = ymdFromSerial(s), B = ymdFromSerial(e);
    let months = (B.y - A.y) * 12 + (B.m - A.m);
    if (B.d < A.d) months -= 1;
    switch (unit) {
      case 'D': return e - s;
      case 'M': return months;
      case 'Y': return Math.floor(months / 12);
      case 'YM': return months % 12;
      case 'MD': return B.d >= A.d ? B.d - A.d : e - addMonths(s, months, false);
      case 'YD': { const yrs = Math.floor(months / 12); return e - addMonths(s, yrs * 12, false); }
      default: return NUM();
    }
  },

  // info
  ISBLANK: (a) => (a[0] instanceof Rng ? a[0].at(0, 0) : a[0]) == null,
  ISNUMBER: (a) => typeof (a[0] instanceof Rng ? a[0].at(0, 0) : a[0]) === 'number',
  ISTEXT: (a) => typeof (a[0] instanceof Rng ? a[0].at(0, 0) : a[0]) === 'string',
  ISERROR: (a) => isErr(a[0] instanceof Rng ? a[0].at(0, 0) : a[0]),
  ISNA: (a) => { const v = a[0] instanceof Rng ? a[0].at(0, 0) : a[0]; return isErr(v) && v.code === '#N/A'; },

  // finance
  PMT: (a) => pmt(num(a[0]), num(a[1]), num(a[2]), num(opt(a[3], 0)), num(opt(a[4], 0))),
  FV: (a) => fvOf(num(a[0]), num(a[1]), num(a[2]), num(opt(a[3], 0)), num(opt(a[4], 0))),
  PV: (a) => {
    const rate = num(a[0]), nper = num(a[1]), p = num(a[2]), fv = num(opt(a[3], 0)), type = num(opt(a[4], 0));
    if (rate === 0) return -(fv + p * nper);
    const f = (1 + rate) ** nper;
    return -(fv + (p * (1 + rate * type) * (f - 1)) / rate) / f;
  },
  NPER: (a) => {
    const rate = num(a[0]), p = num(a[1]), pv = num(a[2]), fv = num(opt(a[3], 0)), type = num(opt(a[4], 0));
    if (rate === 0) return p === 0 ? NUM() : -(pv + fv) / p;
    const q = p * (1 + rate * type) / rate;
    const v = (q - fv) / (q + pv);
    return v <= 0 ? NUM() : Math.log(v) / Math.log(1 + rate);
  },
  RATE: (a) => {
    const nper = num(a[0]), p = num(a[1]), pv = num(a[2]), fv = num(opt(a[3], 0)), type = num(opt(a[4], 0));
    let r = a[5] != null ? num(a[5]) : 0.1;
    const y = (x) => fvOf(x, nper, p, pv, type) - fv;
    for (let k = 0; k < 100; k += 1) {
      const d = (y(r + 1e-7) - y(r)) / 1e-7;
      if (!d || !Number.isFinite(d)) break;
      const nr = r - y(r) / d;
      if (Math.abs(nr - r) < 1e-10) return nr;
      r = nr;
    }
    return NUM();
  },
};

function logicals(a) {
  const out = [];
  for (const { v, inRange } of each(a)) {
    if (isErr(v)) throw v;
    if (typeof v === 'boolean' || typeof v === 'number') out.push(Boolean(v));
    else if (!inRange && typeof v === 'string') { const b = toBool(v); if (isErr(b)) throw b; out.push(b); }
  }
  return out;
}

/** One-line signatures for the formula bar's hint. */
export const SIGS = {
  SUM: 'SUM(value1, [value2, ...])', AVERAGE: 'AVERAGE(value1, [value2, ...])', MIN: 'MIN(value1, [value2, ...])',
  MAX: 'MAX(value1, [value2, ...])', COUNT: 'COUNT(value1, [value2, ...])', COUNTA: 'COUNTA(value1, [value2, ...])',
  COUNTBLANK: 'COUNTBLANK(range)', PRODUCT: 'PRODUCT(value1, [value2, ...])', ROUND: 'ROUND(value, [places])',
  ROUNDUP: 'ROUNDUP(value, [places])', ROUNDDOWN: 'ROUNDDOWN(value, [places])', INT: 'INT(value)', ABS: 'ABS(value)',
  SIGN: 'SIGN(value)', MOD: 'MOD(dividend, divisor)', POWER: 'POWER(base, exponent)', SQRT: 'SQRT(value)', PI: 'PI()',
  CEILING: 'CEILING(value, [factor])', FLOOR: 'FLOOR(value, [factor])', MEDIAN: 'MEDIAN(value1, [value2, ...])',
  SUMPRODUCT: 'SUMPRODUCT(range1, [range2, ...])', SUMIF: 'SUMIF(range, criterion, [sum_range])',
  SUMIFS: 'SUMIFS(sum_range, range1, criterion1, ...)', COUNTIF: 'COUNTIF(range, criterion)',
  COUNTIFS: 'COUNTIFS(range1, criterion1, ...)', AVERAGEIF: 'AVERAGEIF(range, criterion, [average_range])',
  AVERAGEIFS: 'AVERAGEIFS(average_range, range1, criterion1, ...)', MAXIFS: 'MAXIFS(max_range, range1, criterion1, ...)',
  MINIFS: 'MINIFS(min_range, range1, criterion1, ...)', RAND: 'RAND()', RANDBETWEEN: 'RANDBETWEEN(low, high)',
  IF: 'IF(condition, value_if_true, [value_if_false])', IFS: 'IFS(condition1, value1, ...)',
  IFERROR: 'IFERROR(value, value_if_error)', IFNA: 'IFNA(value, value_if_na)', AND: 'AND(logical1, [logical2, ...])',
  OR: 'OR(logical1, [logical2, ...])', XOR: 'XOR(logical1, [logical2, ...])', NOT: 'NOT(logical)', TRUE: 'TRUE()', FALSE: 'FALSE()',
  SWITCH: 'SWITCH(expression, case1, value1, ..., [default])', CONCAT: 'CONCAT(value1, [value2, ...])',
  CONCATENATE: 'CONCATENATE(text1, [text2, ...])', TEXTJOIN: 'TEXTJOIN(delimiter, ignore_empty, text1, ...)',
  LEFT: 'LEFT(text, [count])', RIGHT: 'RIGHT(text, [count])', MID: 'MID(text, start, count)', LEN: 'LEN(text)',
  UPPER: 'UPPER(text)', LOWER: 'LOWER(text)', PROPER: 'PROPER(text)', TRIM: 'TRIM(text)',
  SUBSTITUTE: 'SUBSTITUTE(text, search_for, replace_with, [occurrence])', REPLACE: 'REPLACE(text, position, length, new_text)',
  FIND: 'FIND(search_for, text, [start])', SEARCH: 'SEARCH(search_for, text, [start])', TEXT: 'TEXT(value, format)',
  VALUE: 'VALUE(text)', REPT: 'REPT(text, times)', EXACT: 'EXACT(text1, text2)',
  VLOOKUP: 'VLOOKUP(key, range, index, [is_sorted])', HLOOKUP: 'HLOOKUP(key, range, index, [is_sorted])',
  XLOOKUP: 'XLOOKUP(key, lookup_range, result_range, [if_not_found], [match_mode], [search_mode])',
  INDEX: 'INDEX(range, row, [column])', MATCH: 'MATCH(key, range, [type])', CHOOSE: 'CHOOSE(index, choice1, ...)',
  ROW: 'ROW([cell])', COLUMN: 'COLUMN([cell])', ROWS: 'ROWS(range)', COLUMNS: 'COLUMNS(range)', TODAY: 'TODAY()', NOW: 'NOW()',
  DATE: 'DATE(year, month, day)', YEAR: 'YEAR(date)', MONTH: 'MONTH(date)', DAY: 'DAY(date)', HOUR: 'HOUR(time)',
  MINUTE: 'MINUTE(time)', WEEKDAY: 'WEEKDAY(date, [type])', EDATE: 'EDATE(start, months)', EOMONTH: 'EOMONTH(start, months)',
  DAYS: 'DAYS(end, start)', NETWORKDAYS: 'NETWORKDAYS(start, end, [holidays])', DATEDIF: 'DATEDIF(start, end, unit)',
  ISBLANK: 'ISBLANK(value)', ISNUMBER: 'ISNUMBER(value)', ISTEXT: 'ISTEXT(value)', ISERROR: 'ISERROR(value)', ISNA: 'ISNA(value)',
  PMT: 'PMT(rate, periods, present_value, [future_value], [type])', FV: 'FV(rate, periods, payment, [present_value], [type])',
  PV: 'PV(rate, periods, payment, [future_value], [type])', NPER: 'NPER(rate, payment, present_value, [future_value], [type])',
  RATE: 'RATE(periods, payment, present_value, [future_value], [type], [guess])',
};
