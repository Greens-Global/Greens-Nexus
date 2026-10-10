// Task Module - My Tasks > Time (Oct 2026): the person's own time entries, a
// week at a time, grouped by day with totals. Effort against tasks, not Time
// Clock punches - nothing here touches a timesheet.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { NX, FONT, btn } from './theme';
import { EmptyState } from './components';
import { fmtDate, fmtMinutes, groupTimeByDay } from './lib';
import { LoadingState } from '../components/AsyncState';

const DAY = 86400000;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Monday of the week containing `d`, local time. */
export function weekStart(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7;   // Mon=0
  x.setDate(x.getDate() - dow);
  return x;
}

export default function TimeSheetView({ onOpen }) {
  const { applyServerTask, runningTimer } = useTasks();
  const [start, setStart] = useState(() => weekStart(new Date()));
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const end = useMemo(() => new Date(start.getTime() + 6 * DAY), [start]);
  const from = iso(start), to = iso(end);
  const thisWeek = iso(weekStart(new Date())) === from;

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.getMyTaskTime(from, to).then((r) => { if (alive) setRows(r || []); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
    // Refetch when a timer stops - the entry it closed belongs on this sheet.
  }, [from, to, runningTimer?.entry?.id]);

  const groups = useMemo(() => groupTimeByDay(rows || []), [rows]);
  const total = groups.reduce((n, g) => n + g.minutes, 0);
  const remove = async (e) => {
    setErr('');
    try {
      const res = await api.deleteTaskTime(e.id);
      if (res?.task) applyServerTask(res.task);
      setRows((prev) => prev.filter((x) => x.id !== e.id));
    } catch (ex) { setErr(ex?.message || 'That did not save.'); }
  };

  return (
    <div style={{ margin: 16, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setStart(new Date(start.getTime() - 7 * DAY))} aria-label="Previous week" style={{ ...btn('ghost'), padding: 6 }}><ChevronLeft size={16} /></button>
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{fmtDate(from)} - {fmtDate(to)}</div>
        <button type="button" onClick={() => setStart(new Date(start.getTime() + 7 * DAY))} disabled={thisWeek} aria-label="Next week" style={{ ...btn('ghost'), padding: 6, opacity: thisWeek ? 0.4 : 1 }}><ChevronRight size={16} /></button>
        {!thisWeek && <button type="button" onClick={() => setStart(weekStart(new Date()))} style={{ ...btn('outline'), padding: '4px 10px', fontSize: 12 }}>This Week</button>}
        <div style={{ marginLeft: 'auto', fontSize: 13, color: NX.dim }}>Week total <b style={{ color: NX.ink }}>{fmtMinutes(total)}</b></div>
      </div>
      {err && <div style={{ fontSize: 12, color: NX.red, marginBottom: 8 }}>{err}</div>}
      {rows === null ? <LoadingState />
        : groups.length === 0 ? <EmptyState icon={Clock} title="No Time This Week" hint="Start a timer or log time from any task's Time Tracking section." />
          : groups.map((g) => (
            <div key={g.day} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, background: NX.surface, marginBottom: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', background: NX.surface2, fontSize: 12.5 }}>
                <span style={{ fontWeight: 700, color: NX.ink }}>{fmtDate(g.day)}</span>
                <span style={{ color: NX.dim }}>{fmtMinutes(g.minutes)}</span>
              </div>
              {g.entries.map((e) => (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: `1px solid ${NX.border2 || NX.border}`, fontSize: 13 }}>
                  <button type="button" onClick={() => onOpen?.(e.taskId)} style={{ ...btn('ghost'), padding: 0, fontWeight: 600, color: NX.ink, textAlign: 'left', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{e.taskTitle || 'Task'}</button>
                  <span style={{ flex: 1, minWidth: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.note || (e.source === 'timer' ? 'Timer' : '')}</span>
                  {e.billable && <span style={{ fontSize: 10, fontWeight: 700, color: NX.green }}>BILLABLE</span>}
                  <span style={{ fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums', width: 64, textAlign: 'right' }}>{fmtMinutes(e.minutes)}</span>
                  <button type="button" onClick={() => remove(e)} aria-label="Delete entry" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          ))}
    </div>
  );
}
