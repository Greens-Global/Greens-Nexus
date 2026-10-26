import { ArrowDown, ArrowUp } from 'lucide-react';
import { countText } from '../lib/useActionCounts';

// The "3 waiting below" chip (Oct 25 2026) - lib/useOffscreenCounts.js says
// how many busy modules are out of view and brings the nearest into view.
export default function NavMore({ dir, n, compact = false, onReveal }) {
  if (!n) return null;
  const Arrow = dir === 'below' ? ArrowDown : ArrowUp;
  const text = `${countText(n)} waiting ${dir}`;
  return (
    <button type="button" className={`nav-more is-${dir}`} onClick={() => onReveal(dir)} aria-label={`${text} - show`} title={compact ? text : undefined}>
      <Arrow size={12} aria-hidden="true" />
      {compact ? countText(n) : text}
    </button>
  );
}
