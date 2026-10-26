// The batch bar's Dates panel (Oct 22 2026): Shift By N Days, Set Due Date,
// Set Start Date, Clear Due Date for the selected tasks.
import { useState } from 'react';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { DateField } from './components';
import { bulkDatesSummary } from './calendarMove';

// The Dates action (Oct 22 2026). The server works each task out from its own
// stored date (bulk_update `dates`), so a shift is never computed from what
// this browser last saw, and a due date that needs approval becomes a request
// exactly as it does on one task.
const DATE_OPS = [
  { id: 'shift', label: 'Shift' },
  { id: 'set_due', label: 'Set Due Date' },
  { id: 'set_start', label: 'Set Start Date' },
  { id: 'clear_due', label: 'Clear Due Date' },
];
const MAX_SHIFT_DAYS = 3650;

export default function BulkDatesPanel({ ids, tasks, store, onDone }) {
  const [op, setOp] = useState('shift');
  const [days, setDays] = useState('1');
  const [skipWeekends, setSkipWeekends] = useState(false);
  const [on, setOn] = useState('');
  const [busy, setBusy] = useState(false);
  const idSet = new Set(ids);
  const picked = (tasks || []).filter((t) => idSet.has(t.id));
  const undated = picked.filter((t) => !t.dueOn).length;
  const n = Number.parseInt(days, 10);
  const valid = op === 'shift' ? Number.isFinite(n) && n !== 0 && Math.abs(n) <= MAX_SHIFT_DAYS
    : op === 'clear_due' ? true : !!on;
  const count = `${ids.length} ${ids.length === 1 ? 'Task' : 'Tasks'}`;
  const hint = { fontSize: 12, color: NX.dim, lineHeight: 1.45 };
  const apply = async () => {
    if (!valid || busy) return;
    const body = op === 'shift' ? { op, days: n, skip_weekends: skipWeekends }
      : op === 'clear_due' ? { op } : { op, on };
    setBusy(true);
    try {
      const r = await store.bulkDates(ids, body);
      store.notify?.(bulkDatesSummary(op, r || {}, n));
      // What was left alone, and why (a repeating task cannot land on or
      // before its previous occurrence) - too long for the one-line toast.
      const blocked = r?.blockedTasks || [];
      if (blocked.length) {
        alert(`${blocked.length} of ${ids.length} not moved:\n`
          + blocked.slice(0, 5).map((b) => `"${b.title}": ${b.reason}`).join('\n')
          + (blocked.length > 5 ? `\nand ${blocked.length - 5} more` : ''));
      }
      onDone();
    } catch {
      /* store.bulkDates already said why; the panel stays open */
    } finally {
      setBusy(false);
    }
  };
  const seg = (active) => ({
    borderRadius: 7, padding: '5px 9px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${active ? NX.border : 'transparent'}`, background: active ? NX.surface : 'transparent',
    color: active ? NX.ink : NX.dim, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none', fontFamily: FONT,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>Change Dates on {count}</div>
      <div role="tablist" aria-label="Date Change" style={{ display: 'flex', flexWrap: 'wrap', borderRadius: 9, background: NX.border2, padding: 2, gap: 2 }}>
        {DATE_OPS.map((o) => (
          <button key={o.id} type="button" role="tab" aria-selected={op === o.id} onClick={() => setOp(o.id)} style={seg(op === o.id)}>{o.label}</button>
        ))}
      </div>
      {op === 'shift' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
            Shift By
            <input type="number" inputMode="numeric" value={days} min={-MAX_SHIFT_DAYS} max={MAX_SHIFT_DAYS} step={1}
              aria-label="Days" onChange={(e) => setDays(e.target.value)}
              style={{ ...inputStyle, width: 90, padding: '5px 8px', fontSize: 12.5 }} />
            Days
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <input type="checkbox" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} />
            Skip Weekends
          </label>
          <div style={hint}>
            Start and due dates move together. Use a minus sign to move earlier.
            {skipWeekends && ' Only weekdays are counted, so every date lands on a weekday.'}
            {undated > 0 && ` ${undated} without a due date will be skipped.`}
          </div>
        </>
      )}
      {(op === 'set_due' || op === 'set_start') && (
        <DateField value={on} onChange={(v) => setOn(v || '')} title={op === 'set_due' ? 'Due Date' : 'Start Date'}
          placeholder="Pick a date" style={{ ...inputStyle, padding: '6px 9px', fontSize: 12.5 }} />
      )}
      {op === 'clear_due' && <div style={hint}>Removes the due date from the selected tasks.</div>}
      {op === 'set_due' && <div style={hint}>A later date that needs approval is sent as a request, as on one task.</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={apply} disabled={!valid || busy}
          style={{ ...btn('primary'), fontSize: 12.5, opacity: !valid || busy ? 0.6 : 1 }}>Apply</button>
      </div>
    </div>
  );
}
