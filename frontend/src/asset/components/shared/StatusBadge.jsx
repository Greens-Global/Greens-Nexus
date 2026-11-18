import { daysUntil, formatDate } from '../../lib/format.js';

// A state is plain colored text in the row's own line (Neil, 11/17/2026: no
// pill or tag box around a state). The module's tone names map onto the
// shared --color-* triples; 'mut' is the quiet gray every list uses for
// "nothing yet". The words carry the meaning, the color only reinforces it.
export const TONE_COLOR = {
  green: 'hsl(var(--color-green))',
  orange: 'hsl(var(--color-orange))',
  red: 'hsl(var(--color-red))',
  blue: 'hsl(var(--color-blue))',
  gold: 'hsl(var(--color-gold))',
  purple: 'hsl(var(--color-purple))',
  // In progress / now only (DESIGN.md "Live accent"): the live ink, never a warning.
  live: 'var(--wk-live-ink)',
  mut: 'var(--text-muted)',
};

/** Status words in their tone's color. `onClick` makes it a quiet text button. */
export function StatusBadge({ tone, children, onClick }) {
  const style = { color: TONE_COLOR[tone] || TONE_COLOR.mut, fontWeight: tone === 'mut' || !TONE_COLOR[tone] ? 400 : 500, whiteSpace: 'nowrap' };
  if (!onClick) return <span className="nx-state" style={style}>{children}</span>;
  return (
    <button type="button" title="Open" onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ ...style, border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}>
      {children}
    </button>
  );
}

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Warranty/expiration-style status: Expired / Expires in N days / Active. Window: 90 days. */
export function expirationStatus(d) {
  if (d == null) return <StatusBadge tone="mut">No Date</StatusBadge>;
  if (d < 0) return <StatusBadge tone="mut">Expired</StatusBadge>;
  if (d <= 90) return <StatusBadge tone="orange">Expires in {days(d)}</StatusBadge>;
  return <StatusBadge tone="green">Active</StatusBadge>;
}

/** Inspection/due-date-style status: N days overdue / Due in N days / Due Soon / Current. Window: 30/90 days. */
export function dueDateStatus(d) {
  if (d == null) return <StatusBadge tone="mut">No Date</StatusBadge>;
  if (d < 0) return <StatusBadge tone="red">{days(Math.abs(d))} overdue</StatusBadge>;
  if (d === 0) return <StatusBadge tone="orange">Due Today</StatusBadge>;
  if (d <= 30) return <StatusBadge tone="orange">Due in {days(d)}</StatusBadge>;
  if (d <= 90) return <StatusBadge tone="orange">Due Soon</StatusBadge>;
  return <StatusBadge tone="green">Current</StatusBadge>;
}

/** Renewal-style cell: the formatted date, then Lapsed / Renews in / Current as colored words.
 *  Window: 60 days. Used for AHJ renewal and vendor COI dates. */
export function renewalCell(d, dateLabel) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{dateLabel}</span>
      {d == null ? null
        : d < 0 ? <StatusBadge tone="red">Lapsed {days(Math.abs(d))} ago</StatusBadge>
        : d <= 60 ? <StatusBadge tone="orange">Renews in {days(d)}</StatusBadge>
        : <StatusBadge tone="green">Current</StatusBadge>}
    </span>
  );
}

/** Convenience: build a renewalCell straight from a raw date string. */
export function renewalCellFromDate(dateStr) {
  return renewalCell(daysUntil(dateStr), formatDate(dateStr));
}
