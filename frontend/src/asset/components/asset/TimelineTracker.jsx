import { Check } from 'lucide-react';
import { timelineFold } from '../shared/SimpleRecordTable.jsx';
// "Phase Progress" above the Development Timeline table. Groups the timeline rows by
// `phase`, classifies each phase as done / moving / not started from its rows' status text,
// and draws one row of connected steps (check / live dot / open ring) with the phase's words
// under each. No card around it (Neil, 11/17/2026) - a hairline under it ends it.
//
// Renders null when there are no timeline rows yet, and when the whole timeline is finished
// (the table folds to its one "Development complete" line then).

const DONE_STATUS_RE = /(complete|done|approved|issued|final|paid|recorded|granted)/;
const ACTIVE_STATUS_RE = /(progress|review|pending|submitted|applic|open|active|underway)/;
const NA_RE = /^\s*(n\/?a|not applicable)\s*$/i;

export function TimelineTracker({ rows }) {
  if (!rows || !rows.length || timelineFold(rows)) return null;

  // Group rows into phases in first-seen order, tallying done/active/total per phase
  // (a not-applicable row is neither - it leaves the phase's count).
  const phases = [];
  const seen = {};
  rows.forEach((row) => {
    const status = String(row.status || '');
    if (NA_RE.test(status)) return;
    const name = row.phase || 'Other';
    if (!seen[name]) {
      seen[name] = { name, done: 0, total: 0, active: 0 };
      phases.push(seen[name]);
    }
    seen[name].total++;
    if (DONE_STATUS_RE.test(status.toLowerCase())) seen[name].done++;
    else if (ACTIVE_STATUS_RE.test(status.toLowerCase())) seen[name].active++;
  });
  if (!phases.length) return null;

  return (
    <section aria-label="Phase Progress" style={{ paddingBottom: 18, marginBottom: 18, borderBottom: '1px solid var(--border-color)' }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Phase Progress</h3>
      <ol style={{ display: 'flex', alignItems: 'flex-start', margin: '16px 0 0', padding: '0 0 4px', listStyle: 'none', overflowX: 'auto' }}>
        {phases.map((phase, idx) => {
          const done = phase.done === phase.total;
          const moving = !done && (phase.done > 0 || phase.active > 0);
          const color = done ? 'hsl(var(--color-green))' : moving ? 'var(--wk-live)' : 'var(--border-color)';
          const word = done ? 'Complete' : moving ? `${phase.done} of ${phase.total} done` : 'Not started';
          return (
            <li key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 0', minWidth: 104, position: 'relative' }}>
              {idx > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 10, right: '50%', left: '-50%', height: 2, backgroundColor: done || moving ? color : 'var(--border-color)' }} />}
              <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', zIndex: 1, background: done ? color : 'var(--bg-primary, var(--bg-card))', border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                {done ? <Check size={12} strokeWidth={3} /> : moving ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} /> : null}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'center', marginTop: 8, color: 'var(--text-primary)', lineHeight: 1.3, padding: '0 4px' }}>{phase.name}</span>
              <span style={{ fontSize: 12, marginTop: 2, color: done ? 'hsl(var(--color-green))' : moving ? 'var(--wk-live-ink)' : 'var(--text-muted)' }}>{word}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
