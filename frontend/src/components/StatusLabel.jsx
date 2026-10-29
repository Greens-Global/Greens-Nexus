// The one status label for lists and tables (Neil, Oct 14 2026: the solid,
// edge-to-edge color blocks in the Tickets, Support, Asset Management and Task
// lists were "absolutely hideous"). A soft label: a dot of the status color,
// the words in a deep shade of it, a faint tint behind. It sizes to its words,
// so nothing truncates, and it reads on the light and the dark theme alike
// (style.css .nx-label - the shades are mixed from `color`, so a task
// project's custom status colors get the same treatment).
//
// Color is for what someone has to act on. Priority is a signal, not a block:
// three bars and the word, colored only for Urgent and High.
import { PRIORITY_META } from '../tasks/theme';

export function StatusLabel({ label, color, title, size = 'md', className = '', style }) {
  return (
    <span className={`nx-label${size === 'sm' ? ' nx-label-sm' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--c': color || '#64748b', ...style }} title={title}>
      <span className="nx-label-text">{label}</span>
    </span>
  );
}

// Priority marks (Neil, Oct 28 2026 - the signal bars read as Wi-Fi, and High
// and Urgent looked the same): the direction says the level - double up
// Urgent, up High, equals Medium, down Low - so it reads without color.
// Every priority in Nexus draws this one mark; pickers use PriorityMark.
const MARK = {
  urgent: <><path d="m17 11-5-5-5 5" /><path d="m17 18-5-5-5 5" /></>,
  high: <path d="m18 15-6-6-6 6" />,
  medium: <path d="M6 9.5h12M6 14.5h12" />,
  low: <path d="m6 9 6 6 6-6" />,
};
// Only these two carry color in the word; Medium and Low stay quiet.
const LOUD = new Set(['high', 'urgent']);

export function PriorityMark({ priority, size = 14, color, style }) {
  const d = MARK[priority];
  if (!d) return null;
  return (
    <svg className="nx-prio-mark" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color || 'currentColor'}
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...style }}>{d}</svg>
  );
}

export function PrioritySignal({ priority, title }) {
  const known = PRIORITY_META[priority];
  const m = known || { label: priority || '-', color: '#64748b' };
  return (
    <span className={`nx-prio${LOUD.has(priority) ? ' nx-prio-loud' : ''}`} style={{ '--c': m.color }} title={title || (known ? `${known.label} priority` : undefined)}>
      <PriorityMark priority={priority} />
      <span className="nx-label-text">{m.label}</span>
    </span>
  );
}
