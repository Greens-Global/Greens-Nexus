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
export default function NavCount({ n, corner = false, detail = '' }) {
  if (!n) return null;
  if (corner) return <span className="nav-count is-corner" aria-hidden="true" />;
  return (
    <span className="nav-count" title={detail || undefined} aria-hidden="true">
      {countText(n)}
    </span>
  );
}
