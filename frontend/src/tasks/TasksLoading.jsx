// Task Module - what the screen shows while the task data is still arriving
// (Sep 28). Every task screen used to render straight away from an empty
// store, so for the several seconds a cold load takes it claimed "0 Tasks",
// "0 items" in every group and even "No Tasks - you're all caught up", and a
// task opened from an email's "Open in Nexus" link simply did not appear
// until the list landed. The shell (views/Tasks.jsx) shows this instead until
// TasksContext's `loading` clears - it is the store's own FIRST_PAINT signal
// (tasks + projects + statuses in), so an empty state only ever means empty.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { NX, FONT } from './theme';

// Past this the message admits it is slow rather than looking frozen.
const SLOW_AFTER_MS = 8000;

const ROW_WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%'];

export default function TasksLoading({ opening = false }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const title = opening ? 'Opening your task…' : 'Loading your tasks…';
  const hint = slow
    ? 'Still working on it - this is taking a little longer than usual.'
    : opening ? 'Getting the task details ready.' : 'Getting your tasks and projects ready.';

  return (
    <div role="status" aria-live="polite" aria-busy="true"
      style={{ fontFamily: FONT, padding: '28px 16px', maxWidth: 960, margin: '0 auto', animation: 'fadeIn 0.2s ease' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', marginBottom: 24 }}>
        <Loader2 size={30} aria-hidden="true" style={{ color: 'var(--wk-brand)', animation: 'spin 0.9s linear infinite' }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{title}</div>
        <div style={{ fontSize: 12.5, color: NX.faint }}>{hint}</div>
      </div>
      {/* The shape of a task list, shimmering - so the page reads as "filling
          in", not as a finished, empty screen. */}
      <div aria-hidden="true" style={{ border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden', background: NX.surface }}>
        <div style={{ padding: '10px 16px', background: NX.surface2, boxShadow: `inset 0 -1px 0 ${NX.border}` }}>
          <span className="skel" style={{ width: 120, height: 12 }} />
        </div>
        {ROW_WIDTHS.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', boxShadow: `inset 0 -1px 0 ${NX.border2}` }}>
            <span className="skel" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0 }} />
            <span className="skel" style={{ width: w, height: 12 }} />
            <span className="skel" style={{ width: 72, height: 12, marginLeft: 'auto', flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
