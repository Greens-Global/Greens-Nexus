import { useEffect, useState } from 'react';
// One way to show a financial figure (Nexus Typography Brief, 09/29/2026):
// Inter with tabular figures, right-aligned, two decimals, thousands
// separators, negatives in parentheses in the neutral color, and a
// reserved closing-parenthesis slot on every amount (the `.num` class, see
// style.css) so the cents of positives, negatives, zero and the total sit in
// one column. Every screen in Accounting renders its numbers through this,
// never through its own toLocaleString.

/** "248,310.42" / "(3,418.07)" - two decimals, comma separators, parentheses for a negative. */
export const formatAmount = (value) => {
  const v = Number(value) || 0;
  const abs = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return v < 0 ? `(${abs})` : abs;
};

/** The brief's display scales: exact cents, whole dollars, or thousands ("$321K" style is for KPI cards). */
export const SCALES = [
  { key: 'exact', label: 'Exact' },
  { key: 'whole', label: 'Whole dollars' },
  { key: 'thousands', label: 'Thousands' },
];
export const scaled = (value, scale) => {
  const v = Number(value) || 0;
  // Rounded away from zero for negatives too: (1,500) in thousands is (2), not (1).
  const r = (x) => Math.sign(x) * Math.round(Math.abs(x));
  if (scale === 'whole') return r(v);
  if (scale === 'thousands') return r(v / 1000);
  return v;
};
/** A figure as a display scale shows it: whole dollars and thousands carry no cents. */
export const formatScaled = (value, scale) => {
  if (!scale || scale === 'exact') return formatAmount(value);
  const v = scaled(value, scale);
  const abs = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(v));
  return v < 0 ? `(${abs})` : abs;
};

/** "$321K", "$1.2M" - KPI cards show rounded values, the exact figure on hover. */
export const formatShort = (value) => {
  const v = Number(value) || 0;
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `$${(a / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`
    : a >= 10_000 ? `$${Math.round(a / 1000).toLocaleString('en-US')}K`
      : `$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return v < 0 ? `(${s})` : s;
};

// Amount fields take shorthand and simple math, resolved on blur: "5k" ->
// 5000, "1.2m" -> 1200000, "=1200*3" -> 3600, "(250)" -> -250, "$1,234.50".
export function parseAmountInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let s = raw.replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  if (s.startsWith('=')) {
    const expr = s.slice(1).replace(/([0-9.]+)([kKmM])/g, (_m, n, u) => String(Number(n) * (u.toLowerCase() === 'k' ? 1e3 : 1e6)));
    if (!/^[0-9.+\-*/()\s]+$/.test(expr)) return null;
    try {
      // Only digits and the four operators reach here (checked above).
      const v = Function(`"use strict"; return (${expr});`)();   // eslint-disable-line no-new-func
      return Number.isFinite(v) ? (neg ? -v : v) : null;
    } catch { return null; }
  }
  const m = s.match(/^([+-]?[0-9]*\.?[0-9]+)([kKmM])?$/);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

/**
 * <Amount value={n} /> - the figure, in the .num style.
 *   zero="dash"  a zero prints as a right-aligned dash (financial statements);
 *                the default prints 0.00 (forms, reconciliations, ledger detail).
 *   scale        'exact' | 'whole' | 'thousands' (display only).
 *   short        "$321K" / "$1.2M" with the exact figure in the title (KPI cards).
 */
export default function Amount({ value, zero = '0.00', scale = 'exact', short = false, className = '', style, title }) {
  const v = Number(value) || 0;
  const neg = v < 0;
  const isZero = Math.abs(scaled(v, scale)) < 0.005;
  let text;
  if (short) text = formatShort(v);
  else if (isZero && zero === 'dash') text = '–';
  else text = formatScaled(v, scale);
  return (
    <span className={`num${neg ? ' neg' : ''}${className ? ` ${className}` : ''}`} style={style} title={title ?? (short || (scale !== 'exact') ? formatAmount(v) : undefined)}>
      {text}
    </span>
  );
}

// An amount field: takes shorthand and simple math ("5k", "1.2m", "=1200*3",
// "(250)"), resolved when the field is left, and shows the figure formatted.
// `onChange(number | null)` fires on blur and on Enter.
export function AmountInput({ id, value, onChange, disabled = false, placeholder = '0.00', style, 'aria-label': ariaLabel }) {
  const [text, setText] = useState(() => (value === '' || value == null ? '' : formatAmount(value)));
  // A value set from outside replaces what is shown; typing never does.
  useEffect(() => { setText(value === '' || value == null ? '' : formatAmount(value)); }, [value]);
  const commit = () => {
    const t = text.trim();
    if (!t) { onChange(null); setText(''); return; }
    const v = parseAmountInput(t);
    if (v == null) { setText(value === '' || value == null ? '' : formatAmount(value)); return; }
    onChange(v);
    setText(formatAmount(v));
  };
  return (
    <input id={id} type="text" inputMode="decimal" value={text} disabled={disabled} placeholder={placeholder} aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
      title="Shorthand works: 5k, 1.2m, =1200*3, (250) for a negative"
      className="num" style={{ fontVariantNumeric: 'tabular-nums', ...style }} />
  );
}
