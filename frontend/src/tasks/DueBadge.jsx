// Task Module - "Extended N times" next to a due date (Neil, Sep 24).
//
// Once is yellow, twice orange, three or more red. It is a fact about the task,
// not a verdict on anyone: hovering shows every move - when, from what, to what,
// and who made it - so "extended 3 times" never has to be taken on trust. The
// count itself is kept by the server (backend task_due.py); this only reads it.
import { dueHistoryLines } from './dueHistory';

// Tints ride on the solid color so the pill reads in light and dark themes.
const LEVELS = [
  { color: '#ca8a04' },   // 1 - yellow
  { color: '#ea580c' },   // 2 - orange
  { color: '#dc2626' },   // 3+ - red
];

function extensionColor(count) {
  if (!count) return null;
  return LEVELS[Math.min(count, 3) - 1].color;
}

function timesLabel(n) {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/**
 * compact - the short "Ext 2x" for dense list/board cells; the full
 * "Extended twice" everywhere there is room.
 */
export default function DueBadge({ task, count, nameOf, compact = false, style }) {
  const n = count ?? task?.dueExtensionCount ?? 0;
  if (!n) return null;
  const color = extensionColor(n);
  const lines = task ? dueHistoryLines(task, nameOf).filter((h) => h.extension).map((h) => h.text) : [];
  const title = [`Due date extended ${timesLabel(n)}`, ...lines].join('\n');
  return (
    <span title={title} aria-label={`Due date extended ${timesLabel(n)}`} style={{
      display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', flexShrink: 0,
      padding: compact ? '1px 6px' : '2px 8px', borderRadius: 999,
      fontSize: compact ? 10.5 : 11.5, fontWeight: 700, lineHeight: 1.4,
      color, background: `${color}1f`, border: `1px solid ${color}59`, cursor: 'help',
      ...style,
    }}>
      {compact ? `Ext ${n}x` : `Extended ${timesLabel(n)}`}
    </span>
  );
}
