import { daysUntil, formatDate } from '../../lib/format.js';
import { StatusLabel } from '../../../components/StatusLabel.jsx';

// Nexus's one soft status label (components/StatusLabel.jsx): a dot, the words
// in a deep shade, a faint tint. The module's tone names map onto the shared
// --color-* triples; 'mut' is the quiet slate every list uses for "nothing yet".
const TONE_COLOR = {
  green: 'hsl(var(--color-green))',
  orange: 'hsl(var(--color-orange))',
  red: 'hsl(var(--color-red))',
  blue: 'hsl(var(--color-blue))',
  gold: 'hsl(var(--color-gold))',
  purple: 'hsl(var(--color-purple))',
  mut: '#64748b',
};

/** Status label. `tone` is 'mut' (neutral) or one of TONE_COLOR's keys; `onClick` makes it a button. */
export function StatusBadge({ tone, children, onClick }) {
  const label = <StatusLabel label={children} color={TONE_COLOR[tone] || TONE_COLOR.mut} size="sm" />;
  if (!onClick) return label;
  return (
    <button type="button" title="Open" onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', display: 'inline-flex' }}>
      {label}
    </button>
  );
}

/** Warranty/expiration-style status: Expired / Expires in Nd / Active. Window: 90 days. */
export function expirationStatus(days) {
  if (days == null) return <StatusBadge tone="mut">No Date</StatusBadge>;
  if (days < 0) return <StatusBadge tone="mut">Expired</StatusBadge>;
  if (days <= 90) return <StatusBadge tone="orange">Expires in {days}d</StatusBadge>;
  return <StatusBadge tone="green">Active</StatusBadge>;
}

/** Inspection/due-date-style status: Overdue / Due in Nd / Due Soon / Current. Window: 30/90 days. */
export function dueDateStatus(days) {
  if (days == null) return <StatusBadge tone="mut">No Date</StatusBadge>;
  if (days < 0) return <StatusBadge tone="red">Overdue {Math.abs(days)}d</StatusBadge>;
  if (days <= 30) return <StatusBadge tone="orange">Due in {days}d</StatusBadge>;
  if (days <= 90) return <StatusBadge tone="orange">Due Soon</StatusBadge>;
  return <StatusBadge tone="green">Current</StatusBadge>;
}

/** Renewal-style two-line cell: the formatted date on top, a Lapsed/Renews-in/Current label below.
 *  Window: 60 days. Used for AHJ renewal dates. */
export function renewalCell(days, dateLabel) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.8rem' }}>{dateLabel}</span>
      {days == null ? null
        : days < 0 ? <StatusBadge tone="red">Lapsed {Math.abs(days)}d</StatusBadge>
        : days <= 60 ? <StatusBadge tone="orange">Renews in {days}d</StatusBadge>
        : <StatusBadge tone="green">Current</StatusBadge>}
    </span>
  );
}

/** Convenience: build a renewalCell straight from a raw date string. */
export function renewalCellFromDate(dateStr) {
  return renewalCell(daysUntil(dateStr), formatDate(dateStr));
}
