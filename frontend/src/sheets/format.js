// Sheets: dates as Excel serial numbers, number formats, and reading what a
// person typed into a cell. US formats only (MM/DD/YYYY, 12-hour AM/PM) -
// formatted by hand, never through the browser's locale.

const DAY_MS = 86400000;
const EPOCH_1970 = 25569;   // serial of 01/01/1970

/** Serial for a calendar day (1900 system, keeping Excel's fake 02/29/1900). */
export function serialFromYMD(y, m, d) {
  const ms = Date.UTC(y, m - 1, d);
  let s = ms / DAY_MS + EPOCH_1970;
  if (s < 61) s -= 1;      // before 03/01/1900 Excel counts from 01/01/1900 = 1
  return s;
}

/** {y, m, d} of a serial's whole day. */
export function ymdFromSerial(serial) {
  let s = Math.floor(serial);
  if (s === 60) return { y: 1900, m: 2, d: 29 };
  if (s < 60) s += 1;
  const dt = new Date((s - EPOCH_1970) * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** {h, mi, s} of a serial's fraction of a day. */
export function hmsFromSerial(serial) {
  let secs = Math.round((serial - Math.floor(serial)) * 86400);
  if (secs >= 86400) secs = 86399;
  return { h: Math.floor(secs / 3600), mi: Math.floor((secs % 3600) / 60), s: secs % 60 };
}

/** The serial of a JS Date as it reads on this computer's clock. */
export function serialFromDate(dt) {
  return serialFromYMD(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
    + (dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds()) / 86400;
}

const pad = (n) => String(n).padStart(2, '0');
export const usDate = (serial) => { const { y, m, d } = ymdFromSerial(serial); return `${pad(m)}/${pad(d)}/${y}`; };
export function usTime(serial, seconds = false) {
  const { h, mi, s } = hmsFromSerial(serial);
  return `${h % 12 || 12}:${pad(mi)}${seconds ? ':' + pad(s) : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Decimal places Excel allows: 0 to 15 (toFixed throws past 100, and a stored style may say anything). */
const places = (d) => (Number.isInteger(d) ? Math.max(0, Math.min(15, d)) : 2);

/** 1234567.891 -> "1,234,567.89" (d decimals). */
export function withCommas(n, d0) {
  const d = places(d0);
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(d).split('.');
  const body = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg && Number(Math.abs(n).toFixed(d)) !== 0 ? '-' : '') + body + (frac ? '.' + frac : '');
}

/** A number the way a cell with no format shows it. */
export function formatGeneral(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const p = Number(n.toPrecision(10));
  const s = String(p);
  if (!s.includes('e')) return s;
  return p.toExponential(5).replace(/\.?0+e/, 'E').replace('E+', 'E+');
}

export const NUMBER_FORMATS = [
  ['', 'Automatic'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent'],
  ['date', 'Date'], ['time', 'Time'], ['datetime', 'Date Time'], ['text', 'Plain Text'],
];
export const DEFAULT_DECIMALS = { number: 2, currency: 2, percent: 2 };

/** What a value shows in a cell with style s. */
export function formatValue(v, s) {
  if (v == null) return '';
  if (typeof v === 'object' && v.code) return v.code;     // an error
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return typeof v === 'number' ? '#NUM!' : '';
  const nf = s?.nf || '';
  const d = places(Number.isInteger(s?.d) ? s.d : DEFAULT_DECIMALS[nf]);
  switch (nf) {
    case 'number': return withCommas(v, d);
    case 'currency': return (v < 0 && Number(Math.abs(v).toFixed(d)) !== 0 ? '-$' : '$') + withCommas(Math.abs(v), d);
    case 'percent': return withCommas(v * 100, d) + '%';
    case 'date': return usDate(v);
    case 'time': return usTime(v);
    case 'datetime': return `${usDate(v)} ${usTime(v)}`;
    default:
      if (Number.isInteger(s?.d)) return v.toFixed(places(s.d));
      return formatGeneral(v);
  }
}

const NUM_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i;
const decimalsOf = (t) => { const m = t.match(/\.(\d+)/); return m ? m[1].length : 0; };

/** "1,200.5" -> 1200.5, or null when it is not a plain number. */
export function parseNumber(text) {
  const t = String(text).trim();
  if (!t || !/\d/.test(t) || !NUM_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDatePart(t) {
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  let y, mo, d;
  if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; if (m[3].length === 2) y += y < 30 ? 2000 : 1900; }
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;          // 02/31 is not a day
  return serialFromYMD(y, mo, d);
}

function parseTimePart(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2], s = +(m[3] || 0);
  if (m[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0); }
  if (h > 23 || mi > 59 || s > 59) return null;
  return (h * 3600 + mi * 60 + s) / 86400;
}

/** A date / time / date time typed as text -> {v, nf}, or null. */
export function parseDateText(text) {
  const t = String(text).trim();
  const d = parseDatePart(t);
  if (d != null) return { v: d, nf: 'date' };
  const tm = parseTimePart(t);
  if (tm != null) return { v: tm, nf: 'time' };
  const sp = t.match(/^(\S+)\s+(.+)$/);
  if (sp) {
    const d2 = parseDatePart(sp[1]), t2 = parseTimePart(sp[2]);
    if (d2 != null && t2 != null) return { v: d2 + t2, nf: 'datetime' };
  }
  return null;
}

/**
 * What a person typed -> { v } | { f } plus nf / d when the typing itself
 * said the format ($, %, a date). `nf` is the cell's current number format.
 */
export function parseInput(raw, nf = '') {
  const text = String(raw ?? '');
  if (text === '') return { v: null };
  if (text[0] === "'") return { v: text.slice(1) };
  if (text[0] === '=' && text.length > 1) return { f: text };
  if (nf === 'text') return { v: text };
  const t = text.trim();
  if (/^(true|false)$/i.test(t)) return { v: t.toLowerCase() === 'true' };
  const n = parseNumber(t);
  if (n != null) return { v: n };
  let m = t.match(/^(-)?\$(-)?(.+)$/);
  if (m) {
    const c = parseNumber(m[3]);
    if (c != null) return { v: (m[1] || m[2] ? -1 : 1) * c, nf: 'currency', d: decimalsOf(m[3]) || 2 };
  }
  m = t.match(/^(.+)%$/);
  if (m) {
    const p = parseNumber(m[1]);
    if (p != null) return { v: p / 100, nf: 'percent', d: decimalsOf(m[1]) };
  }
  const dt = parseDateText(t);
  if (dt) return dt;
  return { v: text };
}

/** The text a cell offers for editing (formulas are handled by the caller). */
export function editText(v, s) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') {
    if (s?.nf === 'text') return v;
    const p = parseInput(v);
    return p.v === v ? v : "'" + v;      // keep "00123" text when it is edited again
  }
  switch (s?.nf) {
    case 'percent': return formatGeneral(Number((v * 100).toPrecision(12))) + '%';
    case 'date': return usDate(v);
    case 'time': return usTime(v, true);
    case 'datetime': return `${usDate(v)} ${usTime(v, true)}`;
    default: return formatGeneral(v);
  }
}

// TEXT(value, format_text): the common Excel patterns.
export function textFormat(v, fmt) {
  const f = String(fmt);
  if (typeof v !== 'number') return String(v ?? '');
  if (/[dmyhs]/i.test(f) && !/[#0]/.test(f)) {
    const { y, m, d } = ymdFromSerial(v);
    const { h, mi, s } = hmsFromSerial(v);
    const ampm = /am\/pm/i.test(f);
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    // Tokens longest first; m after h (or before s) means minutes.
    return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm/gi, (tok, off, all) => {
      const lower = tok.toLowerCase();
      const before = all.slice(0, off).toLowerCase();
      const isMin = (lower === 'mm' || lower === 'm') && (/h[^dmy]*$/.test(before) || /^[^dmy]*s/.test(all.slice(off + tok.length).toLowerCase()));
      const hh = ampm ? (h % 12 || 12) : h;
      switch (lower) {
        case 'yyyy': return String(y);
        case 'yy': return pad(y % 100);
        case 'mmmm': return MON[m - 1];
        case 'mmm': return MON[m - 1].slice(0, 3);
        case 'mm': return isMin ? pad(mi) : pad(m);
        case 'm': return isMin ? String(mi) : String(m);
        case 'dddd': return DOW[dow];
        case 'ddd': return DOW[dow].slice(0, 3);
        case 'dd': return pad(d);
        case 'd': return String(d);
        case 'hh': return pad(hh);
        case 'h': return String(hh);
        case 'ss': return pad(s);
        case 's': return String(s);
        default: return h < 12 ? 'AM' : 'PM';
      }
    });
  }
  const pct = f.includes('%');
  const n = pct ? v * 100 : v;
  const m = f.match(/[#0,]*0?(?:\.(0+))?/g)?.find((x) => /[#0]/.test(x)) || '0';
  const dec = (m.split('.')[1] || '').length;
  const body = m.includes(',') ? withCommas(n, dec) : n.toFixed(dec);
  const at = f.indexOf(m);
  return f.slice(0, at).replace(/"/g, '') + body + f.slice(at + m.length).replace(/"/g, '');
}
