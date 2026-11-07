// Sheets formulas: the functions. Each takes (args, env, eng) - args already
// worked out (a range stays a Rng) - and returns a value or an Err.
import { isErr, err, Rng, Arr, toNum, toStr, toBool, compare, maxOf, minOf } from './values.js';
import { serialFromYMD, ymdFromSerial, hmsFromSerial, serialFromDate, textFormat, parseDateText, parseNumber } from '../format.js';

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
// Excel wildcards (* any run, ? any one, ~ escapes) matched without a regular
// expression: the two-pointer matcher is O(text x pattern) at worst and never
// backtracks exponentially, whatever a colleague types into a criterion.
const STAR = { star: true }, ANY = { any: true };
const WILD_STEPS = 2000000;
function globTokens(pat) {
  const out = [];
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '~' && (pat[i + 1] === '*' || pat[i + 1] === '?')) { out.push(pat[i + 1]); i += 1; }
    else if (ch === '*') { if (out[out.length - 1] !== STAR) out.push(STAR); }
    else if (ch === '?') out.push(ANY);
    else out.push(ch.toLowerCase());
  }
  return out;
}
/** Does s (lower case) from index i match the whole pattern? budget = {left} steps, shared by one call. */
function globFrom(toks, s, i, budget) {
  let t = 0, star = -1, mark = i;
  while (i < s.length) {
    if ((budget.left -= 1) < 0) return false;
    const tk = toks[t];
    if (t < toks.length && tk !== STAR && (tk === ANY || tk === s[i])) { t += 1; i += 1; }
    else if (t < toks.length && tk === STAR) { star = t; t += 1; mark = i; }
    else if (star >= 0) { t = star + 1; mark += 1; i = mark; }
    else return false;
  }
  while (t < toks.length && toks[t] === STAR) t += 1;
  return t === toks.length;
}
function wildcard(pat) {
  const toks = globTokens(String(pat));
  const plain = toks.every((x) => typeof x === 'string');
  const lit = plain ? toks.join('') : '';
  return {
    test: (v) => { const s = String(v).toLowerCase(); return plain ? s === lit : globFrom(toks, s, 0, { left: WILD_STEPS }); },
    /** First index in s at or after `from` where the pattern starts, or -1. */
    find: (v, from = 0) => {
      const s = String(v).toLowerCase();
      if (plain) return s.indexOf(lit, from);
      const open = [...toks, STAR], budget = { left: WILD_STEPS };
      for (let i = from; i <= s.length; i += 1) {
        if (globFrom(open, s, i, budget)) return i;
        if (budget.left < 0) return -1;
      }
      return -1;
    },
  };
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
  MIN: (a) => { const n = nums(a); return n.length ? minOf(n) : 0; },
  MAX: (a) => { const n = nums(a); return n.length ? maxOf(n) : 0; },
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
  MAXIFS: (a) => { const n = ifs(range(a[0]), a, 1); return n.length ? maxOf(n) : 0; },
  MINIFS: (a) => { const n = ifs(range(a[0]), a, 1); return n.length ? minOf(n) : 0; },
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
    if (start < 0 || start > hay.length) return VALUE();
    const i = wildcard(str(a[0])).find(hay, start);
    return i < 0 ? VALUE() : i + 1;
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

// ── round two: arrays, statistics, more math, text and dates, variables ──
const scalarOf = (v) => (v instanceof Rng ? v.at(0, 0) : v);
const sampleVar = (n) => {
  if (n.length < 2) throw err('#DIV/0!');
  const m = n.reduce((s, x) => s + x, 0) / n.length;
  return n.reduce((s, x) => s + (x - m) ** 2, 0) / (n.length - 1);
};
const popVar = (n) => {
  if (!n.length) throw err('#DIV/0!');
  const m = n.reduce((s, x) => s + x, 0) / n.length;
  return n.reduce((s, x) => s + (x - m) ** 2, 0) / n.length;
};
const sorted = (a) => nums(a).sort((x, y) => x - y);
function percentile(list, k) {
  if (!list.length || k < 0 || k > 1) throw NUM();
  const pos = (list.length - 1) * k, lo = Math.floor(pos), hi = Math.ceil(pos);
  return list[lo] + (list[hi] - list[lo]) * (pos - lo);
}
const gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
const rowsOf = (v) => (v instanceof Rng ? v.rows : [[v]]);
function isoWeek(serial) {
  const { y, m, d } = ymdFromSerial(serial);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));     // the Thursday of this week
  const jan4 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

Object.assign(FN, {
  // arrays (each answers with an Arr that spills)
  FILTER: (a) => {
    const src = range(a[0]);
    const conds = a.slice(1).filter((x) => x instanceof Rng);
    const ifEmpty = a.length > 1 && !(a[a.length - 1] instanceof Rng) ? a[a.length - 1] : undefined;
    if (!conds.length) return VALUE();
    const byRow = conds.every((c) => c.h === src.h && c.w === 1);
    const byCol = !byRow && conds.every((c) => c.w === src.w && c.h === 1);
    if (!byRow && !byCol) return VALUE();
    const keep = (i) => conds.every((c) => { const v = byRow ? c.at(i, 0) : c.at(0, i); if (isErr(v)) throw v; return toBool(v) === true; });
    const rows = src.rows;
    let out;
    if (byRow) out = rows.filter((_, i) => keep(i));
    else { const cols = Array.from({ length: src.w }, (_, j) => j).filter(keep); out = cols.length ? rows.map((r) => cols.map((j) => r[j])) : []; }
    if (!out.length) return ifEmpty !== undefined ? ifEmpty : err('#N/A', 'No rows match the filter');
    return new Arr(out);
  },
  SORT: (a) => {
    const rows = rowsOf(a[0]).map((r) => r.slice());
    const k = int(opt(a[1], 1)) - 1;
    const o = a[2];
    const desc = o === false || (typeof o === 'number' && o < 0);
    if (rows.length && (k < 0 || k >= rows[0].length)) return VALUE();
    rows.sort((x, y) => { const c = compare(x[k], y[k]); return desc ? -c : c; });
    return new Arr(rows);
  },
  UNIQUE: (a) => {
    const seen = new Set(), out = [];
    for (const r of rowsOf(a[0])) {
      const key = JSON.stringify(r.map((v) => (typeof v === 'string' ? v.toLowerCase() : isErr(v) ? v.code : v)));
      if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    return new Arr(out);
  },
  SEQUENCE: (a) => {
    const h = int(a[0]), w = int(opt(a[1], 1)), start = num(opt(a[2], 1)), step = num(opt(a[3], 1));
    if (h < 1 || w < 1 || h * w > 100000) return VALUE();
    return new Arr(Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => start + step * (i * w + j))));
  },
  TRANSPOSE: (a) => { const rows = rowsOf(a[0]); return new Arr((rows[0] || []).map((_, j) => rows.map((r) => r[j]))); },
  SPLIT: (a) => {
    const s = str(a[0]), d = str(a[1]), each1 = a[2] == null ? true : bool(a[2]), dropEmpty = a[3] == null ? true : bool(a[3]);
    if (!d) return VALUE();
    const parts = each1 ? s.split(new RegExp(`[${d.replace(/[\]\\^-]/g, '\\$&')}]`)) : s.split(d);
    const out = dropEmpty ? parts.filter((x) => x !== '') : parts;
    return new Arr([out.map((x) => { const n = parseNumber(x); return n != null ? n : x; })]);
  },
  INDIRECT: (a, env, eng) => eng.refText(str(a[0]), env),
  OFFSET: (a, env, eng) => {
    const base = range(a[0]);
    if (!base.tab) return VALUE();
    const r1 = base.r1 + int(a[1]), c1 = base.c1 + int(a[2]);
    const h = a[3] == null ? base.h : int(a[3]), w = a[4] == null ? base.w : int(a[4]);
    if (r1 < 0 || c1 < 0 || h < 1 || w < 1) return err('#REF!');
    return eng.rangeOn(base.tab, r1, c1, r1 + h - 1, c1 + w - 1);
  },

  // text
  TEXTBEFORE: (a) => { const s = str(a[0]), d = str(a[1]), n = int(opt(a[2], 1)); const parts = s.split(d); if (!d || !n || parts.length <= Math.abs(n)) return NA(); return n > 0 ? parts.slice(0, n).join(d) : parts.slice(0, parts.length + n).join(d); },
  TEXTAFTER: (a) => { const s = str(a[0]), d = str(a[1]), n = int(opt(a[2], 1)); const parts = s.split(d); if (!d || !n || parts.length <= Math.abs(n)) return NA(); return n > 0 ? parts.slice(n).join(d) : parts.slice(parts.length + n).join(d); },
  JOIN: (a) => { const d = str(a[0]); const out = []; for (const { v } of each(a.slice(1))) { if (isErr(v)) return v; out.push(toStr(v)); } return out.join(d); },
  T: (a) => { const v = scalarOf(a[0]); return typeof v === 'string' ? v : ''; },
  N: (a) => { const v = scalarOf(a[0]); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : isErr(v) ? v : 0; },
  HYPERLINK: (a) => (a[1] != null ? str(a[1]) : str(a[0])),

  // statistics
  COUNTUNIQUE: (a) => { const s = new Set(); for (const { v } of each(a)) if (v != null && v !== '') s.add(typeof v === 'string' ? 's:' + v.toLowerCase() : String(v)); return s.size; },
  AVERAGEA: (a) => {
    const n = [];
    for (const { v } of each(a)) { if (isErr(v)) return v; if (v == null) continue; n.push(typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0); }
    return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err('#DIV/0!');
  },
  STDEV: (a) => Math.sqrt(sampleVar(nums(a))),
  'STDEV.S': (a) => Math.sqrt(sampleVar(nums(a))),
  'STDEV.P': (a) => Math.sqrt(popVar(nums(a))),
  STDEVP: (a) => Math.sqrt(popVar(nums(a))),
  'VAR.S': (a) => sampleVar(nums(a)),
  'VAR.P': (a) => popVar(nums(a)),
  VARP: (a) => popVar(nums(a)),
  // VAR("token") is a Documents variable; VAR(numbers) stays Excel's sample variance.
  VAR: (a, env, eng) => {
    if (a.length === 1 && typeof a[0] === 'string') {
      const token = a[0].replace(/^\s*\{\{\s*|\s*\}\}\s*$/g, '').trim();
      const vars = eng?.vars;
      const values = vars?.values || {};
      const known = !!vars?.tokens?.has(token) || Object.prototype.hasOwnProperty.call(values, token);
      if (!known) return err('#NAME?', `Unknown variable ${token}`);
      const v = values[token];
      if (v == null || v === '') return err('#N/A', 'Pick a person or company for this sheet');
      const n = parseNumber(String(v));
      return n != null ? n : String(v);
    }
    return sampleVar(nums(a));
  },
  LARGE: (a) => { const n = sorted([a[0]]), k = int(a[1]); return k < 1 || k > n.length ? NUM() : n[n.length - k]; },
  SMALL: (a) => { const n = sorted([a[0]]), k = int(a[1]); return k < 1 || k > n.length ? NUM() : n[k - 1]; },
  RANK: (a) => { const v = num(a[0]), n = nums([a[1]]), asc = int(opt(a[2], 0)) !== 0; if (!n.includes(v)) return NA(); return 1 + n.filter((x) => (asc ? x < v : x > v)).length; },
  'RANK.EQ': (a) => FN.RANK(a),
  PERCENTILE: (a) => percentile(sorted([a[0]]), num(a[1])),
  'PERCENTILE.INC': (a) => percentile(sorted([a[0]]), num(a[1])),
  QUARTILE: (a) => { const q = int(a[1]); return q < 0 || q > 4 ? NUM() : percentile(sorted([a[0]]), q / 4); },
  'QUARTILE.INC': (a) => FN.QUARTILE(a),
  MODE: (a) => {
    const n = nums(a), counts = new Map();
    let best = null, bestN = 1;
    for (const x of n) { const k = (counts.get(x) || 0) + 1; counts.set(x, k); if (k > bestN) { bestN = k; best = x; } }
    return best == null ? NA() : best;
  },
  'MODE.SNGL': (a) => FN.MODE(a),

  // math
  MROUND: (a) => { const x = num(a[0]), m = num(a[1]); if (m === 0) return 0; if (Math.sign(x) * Math.sign(m) < 0) return NUM(); return roundTo(x / m, 0) * m; },
  TRUNC: (a) => roundTo(num(a[0]), int(opt(a[1], 0)), 'down'),
  EXP: (a) => Math.exp(num(a[0])),
  LN: (a) => { const x = num(a[0]); return x <= 0 ? NUM() : Math.log(x); },
  LOG: (a) => { const x = num(a[0]), b = num(opt(a[1], 10)); return x <= 0 || b <= 0 || b === 1 ? NUM() : b === 10 ? Math.log10(x) : Math.log(x) / Math.log(b); },
  LOG10: (a) => { const x = num(a[0]); return x <= 0 ? NUM() : Math.log10(x); },
  FACT: (a) => { const n = Math.floor(num(a[0])); if (n < 0 || n > 170) return NUM(); let f = 1; for (let k = 2; k <= n; k += 1) f *= k; return f; },
  GCD: (a) => nums(a).map(Math.floor).reduce(gcd2, 0),
  LCM: (a) => nums(a).map(Math.floor).reduce((x, y) => (x && y ? Math.abs(x * y) / gcd2(x, y) : 0), 1),
  ISEVEN: (a) => Math.floor(Math.abs(num(a[0]))) % 2 === 0,
  ISODD: (a) => Math.floor(Math.abs(num(a[0]))) % 2 === 1,
  ISLOGICAL: (a) => typeof scalarOf(a[0]) === 'boolean',
  ISFORMULA: (a, env, eng) => { const r = range(a[0]); return !!(r.tab && eng.rawCell(r.tab, r.r1, r.c1)?.f); },

  // dates and times
  WORKDAY: (a) => {
    let d = Math.floor(num(a[0]));
    let left = int(a[1]);
    const off = new Set(a[2] != null ? nums([a[2]]).map(Math.floor) : []);
    const step = left < 0 ? -1 : 1;
    while (left !== 0) { d += step; const w = weekday(d); if (w !== 0 && w !== 6 && !off.has(d)) left -= step; }
    return d;
  },
  WEEKNUM: (a) => {
    const s = Math.floor(num(a[0])), type = int(opt(a[1], 1));
    if (type === 21) return isoWeek(s);
    const startDay = type === 2 ? 1 : 0;      // 1 = weeks start Sunday, 2 = Monday
    const jan1 = serialFromYMD(ymdFromSerial(s).y, 1, 1);
    const offset = (weekday(jan1) - startDay + 7) % 7;
    return Math.floor((s - jan1 + offset) / 7) + 1;
  },
  ISOWEEKNUM: (a) => isoWeek(Math.floor(num(a[0]))),
  YEARFRAC: (a) => {
    let s = Math.floor(num(a[0])), e = Math.floor(num(a[1]));
    if (s > e) [s, e] = [e, s];
    const basis = int(opt(a[2], 0));
    const A = ymdFromSerial(s), B = ymdFromSerial(e);
    if (basis === 0) {
      let d1 = A.d, d2 = B.d;
      if (d1 === 31) d1 = 30;
      if (d2 === 31 && d1 === 30) d2 = 30;
      return ((B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1)) / 360;
    }
    if (basis === 2) return (e - s) / 360;
    if (basis === 3) return (e - s) / 365;
    if (basis === 1) {
      const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      let days = 0;
      for (let y = A.y; y <= B.y; y += 1) days += leap(y) ? 366 : 365;
      return (e - s) / (days / (B.y - A.y + 1));
    }
    return NUM();
  },
  TIME: (a) => { const t = (int(a[0]) * 3600 + int(a[1]) * 60 + int(a[2])) / 86400; return t < 0 ? NUM() : t - Math.floor(t); },
  TIMEVALUE: (a) => { const p = parseDateText(str(a[0])); return p ? p.v - Math.floor(p.v) : VALUE(); },
  DATEVALUE: (a) => { const p = parseDateText(str(a[0])); return p && p.nf !== 'time' ? Math.floor(p.v) : VALUE(); },
  SECOND: (a) => hmsFromSerial(num(a[0])).s,
});

Object.assign(SIGS, {
  FILTER: 'FILTER(range, condition1, [condition2, ...])', SORT: 'SORT(range, [sort_column], [is_ascending])', UNIQUE: 'UNIQUE(range)',
  SEQUENCE: 'SEQUENCE(rows, [columns], [start], [step])', TRANSPOSE: 'TRANSPOSE(range)', LET: 'LET(name1, value1, ..., result)',
  INDIRECT: 'INDIRECT(reference_text)', OFFSET: 'OFFSET(reference, rows, columns, [height], [width])', ARRAYFORMULA: 'ARRAYFORMULA(array_formula)',
  TEXTBEFORE: 'TEXTBEFORE(text, delimiter, [instance])', TEXTAFTER: 'TEXTAFTER(text, delimiter, [instance])',
  SPLIT: 'SPLIT(text, delimiter, [split_by_each], [remove_empty])', JOIN: 'JOIN(delimiter, value1, [value2, ...])',
  COUNTUNIQUE: 'COUNTUNIQUE(value1, [value2, ...])', AVERAGEA: 'AVERAGEA(value1, [value2, ...])', STDEV: 'STDEV(value1, [value2, ...])',
  'STDEV.S': 'STDEV.S(value1, [value2, ...])', 'STDEV.P': 'STDEV.P(value1, [value2, ...])', 'VAR.S': 'VAR.S(value1, [value2, ...])',
  'VAR.P': 'VAR.P(value1, [value2, ...])', VAR: 'VAR("variable") - a Documents variable, or VAR(numbers) for variance',
  LARGE: 'LARGE(range, n)', SMALL: 'SMALL(range, n)', RANK: 'RANK(value, range, [ascending])', PERCENTILE: 'PERCENTILE(range, percentile)',
  QUARTILE: 'QUARTILE(range, quartile)', MODE: 'MODE(value1, [value2, ...])', MROUND: 'MROUND(value, factor)', TRUNC: 'TRUNC(value, [places])',
  EXP: 'EXP(exponent)', LN: 'LN(value)', LOG: 'LOG(value, [base])', LOG10: 'LOG10(value)', FACT: 'FACT(value)', GCD: 'GCD(value1, [value2, ...])',
  LCM: 'LCM(value1, [value2, ...])', ISEVEN: 'ISEVEN(value)', ISODD: 'ISODD(value)', ISFORMULA: 'ISFORMULA(cell)', ISLOGICAL: 'ISLOGICAL(value)',
  N: 'N(value)', T: 'T(value)', WORKDAY: 'WORKDAY(start, days, [holidays])', WEEKNUM: 'WEEKNUM(date, [type])', ISOWEEKNUM: 'ISOWEEKNUM(date)',
  YEARFRAC: 'YEARFRAC(start, end, [basis])', TIME: 'TIME(hour, minute, second)', TIMEVALUE: 'TIMEVALUE(text)', DATEVALUE: 'DATEVALUE(text)',
  SECOND: 'SECOND(time)', HYPERLINK: 'HYPERLINK(url, [label])',
});
