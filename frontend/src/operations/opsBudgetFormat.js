// Operations > Ops Budget: how a figure reads on screen. The server sends
// raw values (dollars, counts, fractions for percentages) and the variance
// status; this only formats. A missing value is a dash, never 0%.

export const DASH = '-';

export function fmtValue(unit, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  switch (unit) {
    case 'pct': return `${(v * 100).toFixed(1)}%`;
    case 'money': return `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
    case 'rate': return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'rate1': return v.toFixed(1);
    default: return Math.round(v).toLocaleString('en-US');
  }
}

// The size of a change without its sign: "0.8 pts", "$600", "$1.50", "13".
export function fmtDiff(unit, diff) {
  if (diff === null || diff === undefined) return DASH;
  if (unit === 'pct') return `${Math.abs(diff * 100).toFixed(1)} pts`;
  return fmtValue(unit, Math.abs(diff));
}

// A variance pill: { text, tone, arrow }. tone: good | bad | neutral | none.
export function pill(unit, variance) {
  if (!variance) return { text: DASH, tone: 'none', arrow: null };
  if (variance.status === 'even') return { text: 'Even', tone: 'neutral', arrow: null };
  const tone = variance.status === 'better' ? 'good' : variance.status === 'worse' ? 'bad' : 'neutral';
  return { text: fmtDiff(unit, variance.diff), tone, arrow: variance.arrow };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-09" -> "Sep 2026" (or "September 2026"); short axis label "Sep 26".
export function monthText(ym, { long = false, axis = false } = {}) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) return '';
  const m = Number(ym.slice(5, 7)) - 1;
  if (axis) return `${MONTHS[m]} ${ym.slice(2, 4)}`;
  return `${(long ? LONG : MONTHS)[m]} ${ym.slice(0, 4)}`;
}

export function addMonths(ym, n) {
  const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

// Newest first, from `to` back to `from` (both YYYY-MM).
export function monthOptions(from, to) {
  const out = [];
  for (let m = to; m >= from; m = addMonths(m, -1)) out.push(m);
  return out;
}

// A metric the payload does not carry reads as all dashes instead of crashing a card.
export const EMPTY_METRIC = Object.freeze({ budget: null, actual: null, lastYear: null, vsBudget: null, vsLastYear: null, unit: 'count', pending: false });
export const byKey = (report) => {
  const map = Object.fromEntries((report?.metrics || []).map((m) => [m.key, m]));
  return new Proxy(map, { get: (t, k) => (typeof k === 'string' && !(k in t) ? EMPTY_METRIC : t[k]) });
};
