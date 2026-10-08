import { useEffect, useState } from 'react';
// One way to show a financial figure in Accounting (Charmi, 09/30 - the
// numbers part of the typography brief, for Accounting only): Inter with
// tabular digits, two decimals, thousands separators, a negative in
// parentheses, and a reserved closing-parenthesis slot (the `.num` class in
// style.css, scoped to .acct-module) so the digits of positives, negatives,
// zero and the total sit in one column - the parentheses stand outside the
// digit column. Every Accounting screen renders its figures through this,
// never through its own toLocaleString.

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** "248,310.42" / "(3,418.07)" - two decimals, comma separators, parentheses for a negative. */
export const formatAmount = (value) => {
  const v = round2(value);
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${abs})` : abs;
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

const numClass = (neg, className) => `num${neg ? ' neg' : ''}${className ? ` ${className}` : ''}`;

/**
 * <Amount value={n} /> - the figure, in the .num style.
 *   zero  '0.00' (the default: forms, reconciliations, entry detail),
 *         'dash' (a statement shows nothing as a right-aligned "-"), or
 *         'blank' (a debit or credit column leaves the other side empty).
 */
export default function Amount({ value, zero = '0.00', className = '', style, title }) {
  const v = round2(value);
  const neg = v < 0;
  const text = v === 0 ? (zero === 'dash' ? '-' : zero === 'blank' ? '' : '0.00') : formatAmount(v);
  return <span className={numClass(neg, className)} style={style} title={title}>{text}</span>;
}

/** A figure that is already text ("(12.0%)", "19.8%", "50%"): the same slot, so a percent column lines up too. */
export function Figure({ text, className = '', style, title }) {
  const s = text == null ? '' : String(text);
  return <span className={numClass(s.startsWith('('), className)} style={style} title={title}>{s}</span>;
}

// An amount field: takes shorthand and simple math ("5k", "1.2m", "=1200*3",
// "(250)"), resolved when the field is left, and shows the figure formatted
// with its separators and two decimals. `onChange(number | null)` fires on
// blur and on Enter.
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
      className="num" style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', ...style }} />
  );
}
