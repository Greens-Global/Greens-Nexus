import { daysUntil, formatDate } from '../../lib/format.js';

const TONE_COLOR = {
  green: 'var(--color-green)',
  orange: 'var(--color-orange)',
  red: 'var(--color-red)',
  blue: 'var(--color-blue)',
};

/** Small rounded pill badge. `tone` is 'mut' (neutral/muted) or one of TONE_COLOR's keys. */
export function StatusBadge({ tone, children, onClick }) {
  const clickProps = onClick ? { onClick: (e) => { e.stopPropagation(); onClick(); }, title: 'Open' } : {};
  const clickStyle = onClick ? { cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 } : {};
  const baseStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.72rem',
    fontWeight: 600,
    padding: '3px 9px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
    ...clickStyle,
  };

  if (tone === 'mut') {
    return (
      <span {...clickProps} style={{ ...baseStyle, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)' }}>
        {children}
      </span>
    );
  }
  const c = TONE_COLOR[tone];
  return (
    <span {...clickProps} style={{ ...baseStyle, color: `hsl(${c})`, backgroundColor: `hsla(${c}, 0.12)` }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(${c})` }} />
      {children}
    </span>
  );
}

/** Warranty/expiration-style status: Expired / Expires in Nd / Active. Window: 90 days. */
export function expirationStatus(days) {
  if (days == null) return <StatusBadge tone="mut">No date</StatusBadge>;
  if (days < 0) return <StatusBadge tone="mut">Expired</StatusBadge>;
  if (days <= 90) return <StatusBadge tone="orange">Expires in {days}d</StatusBadge>;
  return <StatusBadge tone="green">Active</StatusBadge>;
}

/** Inspection/due-date-style status: Overdue / Due in Nd / Due soon / Current. Window: 30/90 days. */
export function dueDateStatus(days) {
  if (days == null) return <StatusBadge tone="mut">No date</StatusBadge>;
  if (days < 0) return <StatusBadge tone="red">Overdue {Math.abs(days)}d</StatusBadge>;
  if (days <= 30) return <StatusBadge tone="orange">Due in {days}d</StatusBadge>;
  if (days <= 90) return <StatusBadge tone="orange">Due soon</StatusBadge>;
  return <StatusBadge tone="green">Current</StatusBadge>;
}

/** Renewal-style two-line cell: the formatted date on top, a Lapsed/Renews-in/Current badge below.
 *  Window: 60 days. Used for AHJ renewal dates. */
export function renewalCell(days, dateLabel) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.78rem' }}>{dateLabel}</span>
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
