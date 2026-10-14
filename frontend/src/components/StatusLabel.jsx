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

const BARS = { low: 1, medium: 2, high: 3, urgent: 3 };
// Only these two carry color; Medium and Low stay quiet.
const LOUD = new Set(['high', 'urgent']);

export function PrioritySignal({ priority, title }) {
  const known = PRIORITY_META[priority];
  const m = known || { label: priority || '-', color: '#64748b' };
  const n = BARS[priority] || 0;
  return (
    <span className={`nx-prio${LOUD.has(priority) ? ' nx-prio-loud' : ''}`} style={{ '--c': m.color }} title={title || (known ? `${known.label} priority` : undefined)}>
      <span className="nx-prio-bars" aria-hidden="true">
        {[0, 1, 2].map((i) => <i key={i} className={i < n ? 'on' : ''} />)}
      </span>
      <span className="nx-label-text">{m.label}</span>
    </span>
  );
}
