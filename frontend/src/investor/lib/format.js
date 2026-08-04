// Shared formatting for the Investor Relations module.
import { formatDate as usFormatDate } from '../../lib/datetime';

// Money: whole dollars for anything >= $1,000, cents below that.
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const USD_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatCurrency(n) {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (Number.isNaN(v)) return '-';
  return Math.abs(v) >= 1000 ? USD_WHOLE.format(v) : USD_CENTS.format(v);
}

export function formatPercent(n) {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (Number.isNaN(v)) return '-';
  return `${v.toFixed(1)}%`;
}

// Multiples (DPI / TVPI / MOIC) render as "1.34x".
export function formatMultiple(n) {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (Number.isNaN(v)) return '-';
  return `${v.toFixed(2)}x`;
}

export function formatDate(iso) {
  // US MM/DD/YYYY, dash on empty/invalid. Delegates to the canonical formatter.
  return usFormatDate(iso, '-');
}

// Form helper: '' / bad input → null so optional numeric fields PATCH cleanly.
export function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Status → color. Rendered everywhere as colored text with a small solid dot
// (see StatusText in ./ui.jsx) - never as a tinted chip/pill.
export const STATUS_COLOR = {
  // green - good / settled
  active:   'hsl(var(--color-green))',
  paid:     'hsl(var(--color-green))',
  cleared:  'hsl(var(--color-green))',
  verified: 'hsl(var(--color-green))',
  closed:   'hsl(var(--color-green))',
  // blue - in flight
  open:           'hsl(var(--color-blue))',
  issued:         'hsl(var(--color-blue))',
  in_review:      'hsl(var(--color-blue))',
  self_certified: 'hsl(var(--color-blue))',
  // orange - waiting on someone
  pending:    'hsl(var(--color-orange))',
  raising:    'hsl(var(--color-orange))',
  unverified: 'hsl(var(--color-orange))',
  draft:      'hsl(var(--color-orange))',
  prospect:   'hsl(var(--color-orange))',
  // red - needs attention
  overdue:   'hsl(var(--color-red))',
  flagged:   'hsl(var(--color-red))',
  withdrawn: 'hsl(var(--color-red))',
  rejected:  'hsl(var(--color-red))',
  // muted - terminal / neutral
  exited:   'var(--muted)',
  waived:   'var(--muted)',
  inactive: 'var(--muted)',
};

export function statusColor(status) {
  return STATUS_COLOR[String(status || '').toLowerCase()] || 'var(--muted)';
}

// snake_case enum → Title Case label, with acronym/spelling overrides.
const LABEL_OVERRIDES = {
  k1: 'K-1',
  ppm: 'PPM',
  ira: 'IRA',
  llc: 'LLC',
  self_certified: 'Self-Certified',
  in_review: 'In Review',
};

export function statusLabel(s) {
  if (!s) return '-';
  const k = String(s).toLowerCase();
  if (LABEL_OVERRIDES[k]) return LABEL_OVERRIDES[k];
  return k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
