import { useEffect, useState } from 'react';
import { countText } from '../lib/useActionCounts';

// What is waiting on me, on a module in the sidebar and the phone menu (Neil,
// Oct 25 2026: the red dot "doesn't show up properly... it's also weird").
// Quiet, the way Linear, Slack and GitHub do it (Neil: "make this more
// subtle"): in a row, the module's name goes a step bolder and a small muted
// number sits at the row's end; on the folded rail, where a number has no
// room to read well, a small accent dot on the icon's corner (its tooltip
// says how many). Red is the bell's alone. The row's accessible name carries
// the count, so this is hidden from screen readers; `detail` (where the
// count comes from) is the number's tooltip.
//
// `order` is the row's place in the sidebar's cascade (--i, see Sidebar.jsx).
// A count that changes while the rail is on screen bumps once (`is-bump`,
// style.css "Rail motion") - still the same quiet gray number.
export default function NavCount({ n, corner = false, detail = '', order }) {
  // "Information from previous renders": the previous count decides whether
  // this render is a change worth a bump. Cleared on a timer.
  const [prevN, setPrevN] = useState(n);
  const [bump, setBump] = useState(false);
  if (prevN !== n) { setPrevN(n); setBump(!!n && !!prevN); }
  useEffect(() => {
    if (!bump) return undefined;
    const t = setTimeout(() => setBump(false), 340);
    return () => clearTimeout(t);
  }, [bump]);
  if (!n) return null;
  if (corner) return <span className="nav-count is-corner" aria-hidden="true" />;
  return (
    <span className={`nav-count${bump ? ' is-bump' : ''}`} title={detail || undefined} aria-hidden="true"
      style={order != null ? { '--i': order } : undefined}>
      {countText(n)}
    </span>
  );
}
