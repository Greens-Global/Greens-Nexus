// Horizontal "Phase Progress" tracker shown above the Development Timeline table. Groups the
// timeline rows by `phase`, classifies each phase as done/active/not-started from its rows'
// status text, and renders a row of connected step circles (checkmark / dot / blank).
//
// Renders null when there are no timeline rows yet.

import { Card } from '../shared/Card.jsx';

const DONE_STATUS_RE = /(complete|done|approved|issued|final|paid|recorded|granted)/;
const ACTIVE_STATUS_RE = /(progress|review|pending|submitted|applic|open|active|underway)/;

/** green if every row in the phase is done, gold if some are done/active, else mut (not started). */
function phaseTone(phase) {
  if (phase.done === phase.total) return 'green';
  if (phase.done || phase.active) return 'gold';
  return 'mut';
}

export function TimelineTracker({ rows }) {
  if (!rows || !rows.length) return null;

  // Group rows into phases in first-seen order, tallying done/active/total per phase.
  const phases = [];
  const seen = {};
  rows.forEach((row) => {
    const name = row.phase || 'Other';
    if (!seen[name]) {
      seen[name] = { name, done: 0, total: 0, active: 0 };
      phases.push(seen[name]);
    }
    const status = String(row.status || '').toLowerCase();
    seen[name].total++;
    if (DONE_STATUS_RE.test(status)) seen[name].done++;
    else if (ACTIVE_STATUS_RE.test(status)) seen[name].active++;
  });

  return (
    <Card>
      <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Phase Progress</strong>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 16, overflowX: 'auto', paddingBottom: 6 }}>
        {phases.map((phase, idx) => {
          const tone = phaseTone(phase);
          const color = tone === 'mut' ? 'var(--text-muted)' : `hsl(var(--color-${tone}))`;
          return (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 0', minWidth: 92, position: 'relative' }}>
              {idx > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: '50%',
                    left: '-50%',
                    height: 3,
                    backgroundColor: 'var(--border-color)',
                    zIndex: 0,
                  }}
                />
              )}
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  zIndex: 1,
                  background: tone === 'mut' ? 'var(--bg-secondary)' : color,
                  border: `2px solid ${color}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tone === 'mut' ? 'var(--text-muted)' : '#fff',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                }}
              >
                {phase.done === phase.total ? '✓' : phase.active ? '•' : ''}
              </div>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, textAlign: 'center', marginTop: 7, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                {phase.name}
              </div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                {phase.done}/{phase.total} done
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
