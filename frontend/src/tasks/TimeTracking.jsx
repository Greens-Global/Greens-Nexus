// Task Module - time on a task (Oct 2026): a running timer (one per person,
// on any task), typed-in minutes, and the entries behind the task's tracked
// total. The backend (routers/tasks.py, /tasks/{id}/time) rolls entries up
// into actualHours; every write here hands the returned task to the store.
// Not Time Clock: punches are attendance and payroll, this is effort against
// a task.
import { useEffect, useState } from 'react';
import { Play, Square, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Avatar, localTodayISO } from './components';
import { fmtDate, fmtHours, fmtMinutes, fmtElapsed } from './lib';

/** Ticks once a second while `startedAt` is set. */
export function useElapsed(startedAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt ? fmtElapsed(startedAt, now) : '';
}

export default function TimeTracking({ task, canLog = true }) {
  const { runningTimer, startTimer, stopTimer, applyServerTask, nameOf, myEmail } = useTasks();
  const [entries, setEntries] = useState(null);
  const [hrs, setHrs] = useState('');
  const [mins, setMins] = useState('');
  const [note, setNote] = useState('');
  const [on, setOn] = useState(localTodayISO());
  const [stopNote, setStopNote] = useState('');
  const [editing, setEditing] = useState(null);   // { id, minutes, note }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const taskId = task?.id;
  const runningHere = runningTimer?.entry?.taskId === taskId ? runningTimer.entry : null;
  const runningElsewhere = runningTimer && !runningHere ? runningTimer : null;
  const elapsed = useElapsed(runningHere?.startedAt);

  const load = () => api.getTaskTime(taskId).then((rows) => setEntries(rows || [])).catch(() => setEntries([]));
  useEffect(() => { let alive = true; api.getTaskTime(taskId).then((rows) => { if (alive) setEntries(rows || []); }).catch(() => { if (alive) setEntries([]); }); return () => { alive = false; }; }, [taskId]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e?.message || 'That did not save.'); } finally { setBusy(false); }
  };
  const start = () => run(async () => { await startTimer(taskId); await load(); });
  const stop = () => run(async () => { await stopTimer({ note: stopNote.trim() }); setStopNote(''); await load(); });
  const addManual = () => {
    const minutes = (Number(hrs) || 0) * 60 + (Number(mins) || 0);
    if (minutes < 1) return;
    run(async () => {
      const res = await api.addTaskTime(taskId, { minutes, note: note.trim(), on });
      if (res?.task) applyServerTask(res.task);
      setHrs(''); setMins(''); setNote('');
      await load();
    });
  };
  const remove = (e) => run(async () => {
    const res = await api.deleteTaskTime(e.id);
    if (res?.task) applyServerTask(res.task);
    setEntries((prev) => prev.filter((x) => x.id !== e.id));
  });
  const saveEdit = () => run(async () => {
    const minutes = Math.max(1, Math.round(Number(editing.minutes) || 0));
    const res = await api.updateTaskTime(editing.id, { minutes, note: editing.note });
    if (res?.task) applyServerTask(res.task);
    setEditing(null);
    await load();
  });

  const tracked = Number(task?.actualHours) || 0;
  const estimate = Number(task?.estimateHours) || 0;
  const pct = estimate > 0 ? Math.min(100, Math.round((tracked / estimate) * 100)) : 0;
  const closed = (entries || []).filter((e) => !e.running);

  return (
    <div style={{ fontSize: 13 }} data-testid="time-tracking">
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div><div style={{ color: NX.faint }}>Estimate</div><div style={{ fontWeight: 700, color: NX.ink }}>{fmtHours(estimate)}</div></div>
        <div><div style={{ color: NX.faint }}>Tracked</div><div style={{ fontWeight: 700, color: tracked > estimate && estimate ? NX.red : NX.blue }}>{fmtHours(tracked)}</div></div>
        {estimate > 0 && (
          <div style={{ flex: 1, minWidth: 120 }}>
            <div style={{ height: 6, borderRadius: 999, background: NX.border2 || NX.border, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: tracked > estimate ? NX.red : NX.blue, transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: 11, color: NX.faint, marginTop: 3 }}>{pct}% of estimate{tracked > estimate ? ` - over by ${fmtHours(tracked - estimate)}` : ''}</div>
          </div>
        )}
        {canLog && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {runningHere ? (
              <>
                <span aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: NX.green, fontSize: 15 }}>{elapsed}</span>
                <input value={stopNote} onChange={(e) => setStopNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && stop()} placeholder="What did you do?" aria-label="Timer note"
                  style={{ ...inputStyle, width: 170, padding: '6px 8px', fontSize: 12 }} />
                <button type="button" onClick={stop} disabled={busy} style={{ ...btn('primary'), background: NX.red, borderColor: NX.red, padding: '6px 10px', fontSize: 12 }}><Square size={12} /> Stop</button>
              </>
            ) : (
              <button type="button" onClick={start} disabled={busy} title={runningElsewhere ? `Stops the timer on "${runningElsewhere.task?.title || 'another task'}"` : 'Start a timer on this task'}
                style={{ ...btn('primary'), padding: '6px 10px', fontSize: 12 }}>
                <Play size={12} /> {runningElsewhere ? 'Switch Timer Here' : 'Start Timer'}
              </button>
            )}
          </div>
        )}
      </div>
      {runningElsewhere && canLog && (
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>Your timer is running on "{runningElsewhere.task?.title || 'another task'}".</div>
      )}

      {canLog && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <Plus size={14} style={{ color: NX.faint }} />
          <input value={hrs} onChange={(e) => setHrs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManual()} type="number" min="0" step="1" placeholder="hrs" aria-label="Hours"
            style={{ ...inputStyle, width: 56, padding: '6px 8px', fontSize: 12 }} />
          <span style={{ color: NX.faint }}>:</span>
          <input value={mins} onChange={(e) => setMins(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManual()} type="number" min="0" max="59" step="5" placeholder="min" aria-label="Minutes"
            style={{ ...inputStyle, width: 56, padding: '6px 8px', fontSize: 12 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addManual()} placeholder="Note (optional)" aria-label="Note"
            style={{ ...inputStyle, flex: 1, minWidth: 120, padding: '6px 8px', fontSize: 12 }} />
          <input type="date" value={on} max={localTodayISO()} onChange={(e) => setOn(e.target.value || localTodayISO())} aria-label="Day"
            style={{ ...inputStyle, width: 140, padding: '6px 8px', fontSize: 12 }} />
          <button type="button" onClick={addManual} disabled={busy || ((Number(hrs) || 0) * 60 + (Number(mins) || 0)) < 1} style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12 }}>Log Time</button>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: NX.red, marginTop: 6 }}>{error}</div>}

      {entries === null ? <div style={{ fontSize: 12, color: NX.faint, marginTop: 10 }}>Loading time entries…</div>
        : closed.length === 0 ? <div style={{ fontSize: 12, color: NX.faint, marginTop: 10 }}>No time logged yet.</div>
          : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {closed.map((e) => {
                const mine = e.personId === myEmail;
                const isEditing = editing?.id === e.id;
                return (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 7, fontSize: 12.5 }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = NX.hover)} onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}>
                    <Avatar email={e.personId} name={nameOf(e.personId)} size={20} />
                    <span style={{ color: NX.dim, width: 84, flexShrink: 0 }}>{fmtDate(e.startedAt)}</span>
                    {isEditing ? (
                      <>
                        <input type="number" min="1" value={editing.minutes} onChange={(ev) => setEditing({ ...editing, minutes: ev.target.value })} aria-label="Edit minutes"
                          style={{ ...inputStyle, width: 70, padding: '4px 6px', fontSize: 12 }} />
                        <span style={{ color: NX.faint }}>min</span>
                        <input value={editing.note} onChange={(ev) => setEditing({ ...editing, note: ev.target.value })} aria-label="Edit note"
                          style={{ ...inputStyle, flex: 1, minWidth: 80, padding: '4px 6px', fontSize: 12 }} />
                        <button type="button" onClick={saveEdit} aria-label="Save entry" style={{ ...btn('ghost'), padding: 3, color: NX.green }}><Check size={13} /></button>
                        <button type="button" onClick={() => setEditing(null)} aria-label="Cancel edit" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>
                      </>
                    ) : (
                      <>
                        <span style={{ fontWeight: 700, color: NX.ink, width: 64, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtMinutes(e.minutes)}</span>
                        <span style={{ flex: 1, minWidth: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.note || (e.source === 'timer' ? 'Timer' : '')}</span>
                        {e.billable && <span style={{ fontSize: 10, fontWeight: 700, color: NX.green }}>BILLABLE</span>}
                        {mine && (
                          <>
                            <button type="button" onClick={() => setEditing({ id: e.id, minutes: e.minutes, note: e.note || '' })} aria-label="Edit entry" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><Pencil size={12} /></button>
                            <button type="button" onClick={() => remove(e)} aria-label="Delete entry" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><Trash2 size={12} /></button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      <div style={{ fontSize: 11, color: NX.faint, marginTop: 8, fontFamily: FONT }}>Time here is effort on this task. It is not a Time Clock punch and does not touch your timesheet.</div>
    </div>
  );
}
