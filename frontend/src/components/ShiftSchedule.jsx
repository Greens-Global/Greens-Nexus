import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, X, Clock, CalendarDays, CalendarRange, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';

// ── Weekly schedule grid (Microsoft Teams "Shifts" style) ─────────────────────
// Rows = employees (grouped by shift group), columns = the 7 days of the week.
// Each cell holds a placed shift (colour + code + time + label); approved/pending
// time off shows as a "Requested off" cell. Per-day and per-week hour totals sum
// live off the placed shift durations.

const TYPE_TINT = { vacation: '#dbeafe', sick: '#dcfce7', personal: '#ede9fe', unpaid: '#f3f4f6', other: '#fef3c7' };
const isoDate = (d) => d.toISOString().slice(0, 10);
const toMin = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const durMin = (s, e) => { let d = toMin(e) - toMin(s); if (d <= 0) d += 1440; return d; };
const fmtHrs = (min) => `${(min / 60).toFixed(min % 60 ? 1 : 0)} Hrs`;
const t12 = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  const ap = h >= 12 ? 'p' : 'a'; const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
};

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export default function ShiftSchedule({ toastOk, toastErr }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [data, setData] = useState(null);
  const [cell, setCell] = useState(null);   // { email, date, existing? }
  const [openCell, setOpenCell] = useState(null);   // { date, existing? } - open-shift editor
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d;
  }), [weekStart]);
  const start = isoDate(days[0]);
  const end = isoDate(days[6]);

  const load = useCallback(() => {
    setData(null);
    api.timeSchedule(start, end).then(setData).catch(e => { setData({ employees: [], shifts: [], groups: [], scheduled: [], timeoff: [] }); toastErr?.(e?.message || 'Could not load the schedule.'); });
  }, [start, end, toastErr]);
  useEffect(load, [load]);

  // index: "email|date" -> [shifts]; and time off lookup. Open shifts (email '')
  // are indexed by date on their own so they render in the Open shifts row.
  const byCell = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach(s => { if (s.email) (map[`${s.email}|${s.date}`] ||= []).push(s); });
    return map;
  }, [data]);
  const openByDate = useMemo(() => {
    const map = {};
    (data?.scheduled || []).forEach(s => { if (!s.email) (map[s.date] ||= []).push(s); });
    return map;
  }, [data]);
  const openCount = (data?.scheduled || []).reduce((a, s) => a + (!s.email ? (s.openSlots || 1) : 0), 0);
  const offOn = (email, ds) => (data?.timeoff || []).find(t => t.email === email && t.startDate <= ds && ds <= t.endDate);

  // group employees by shift group; the rest go under "Everyone else"
  const groupsView = useMemo(() => {
    if (!data) return [];
    const emps = data.employees;
    const byEmail = Object.fromEntries(emps.map(e => [e.email, e]));
    const claimed = new Set();
    const out = [];
    (data.groups || []).forEach(g => {
      const members = g.members.map(m => byEmail[m]).filter(Boolean);
      members.forEach(m => claimed.add(m.email));
      if (members.length) out.push({ name: g.name, members });
    });
    const rest = emps.filter(e => !claimed.has(e.email));
    if (rest.length) out.push({ name: out.length ? 'Everyone else' : 'Team', members: rest });
    return out;
  }, [data]);

  const empWeekMin = (email) => days.reduce((sum, d) => sum + (byCell[`${email}|${isoDate(d)}`] || []).reduce((a, s) => a + durMin(s.start, s.end), 0), 0);
  const dayStats = (d) => {
    const ds = isoDate(d);
    let min = 0; const people = new Set();
    (data?.scheduled || []).forEach(s => { if (s.date === ds) { min += durMin(s.start, s.end); people.add(s.email); } });
    return { min, people: people.size };
  };
  const weekMin = (data?.scheduled || []).reduce((a, s) => a + durMin(s.start, s.end), 0);

  async function saveCell(payload) {
    setBusy(true);
    try {
      if (payload.id) await api.timeSchedUpdate(payload.id, payload);
      else await api.timeSchedCreate(payload);
      toastOk?.('Shift saved.'); setCell(null); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function delCell(id) {
    setBusy(true);
    try { await api.timeSchedDelete(id); toastOk?.('Shift removed.'); setCell(null); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not remove.'); }
    setBusy(false);
  }
  async function saveOpen(payload) {
    setBusy(true);
    try {
      if (payload.id) await api.timeSchedUpdate(payload.id, payload);
      else await api.timeSchedCreate({ ...payload, employee_email: '' });
      toastOk?.('Open shift saved.'); setOpenCell(null); load();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function assignOpen(id, email) {
    setBusy(true);
    try { await api.timeSchedAssign(id, email); toastOk?.('Shift assigned.'); setOpenCell(null); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not assign.'); }
    setBusy(false);
  }
  async function bulkAssign(payload) {
    setBusy(true);
    try {
      const r = await api.timeSchedBulk(payload);
      const bits = [`Placed ${r.created} shift${r.created !== 1 ? 's' : ''} across ${r.people} ${r.people === 1 ? 'person' : 'people'}`];
      if (r.replaced) bits.push(`replaced ${r.replaced}`);
      if (r.skipped) bits.push(`kept ${r.skipped} existing`);
      if (r.timeoffSkipped) bits.push(`skipped ${r.timeoffSkipped} on time off`);
      toastOk?.(bits.join(' · ') + '.');
      setBulkOpen(false); load();
    } catch (e) { toastErr?.(e?.message || 'Could not fill the schedule.'); }
    setBusy(false);
  }

  const shiftWeek = (n) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + n * 7); setWeekStart(d); };
  const rangeLabel = `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const GRID = { display: 'grid', gridTemplateColumns: '190px repeat(7, minmax(120px, 1fr))' };

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => setWeekStart(mondayOf(new Date()))}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} /> Today</button>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" onClick={() => shiftWeek(-1)} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <button className="icon-btn" onClick={() => shiftWeek(1)} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{rangeLabel}</span>
        <div style={{ flex: 1 }} />
        <button className="primary-btn" onClick={() => setBulkOpen(true)}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CalendarRange size={14} /> Fill schedule
        </button>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Week: {fmtHrs(weekMin)}</span>
      </div>

      {data === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
          <div style={{ minWidth: 900 }}>
            {/* Day header */}
            <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
              <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Schedule</div>
              {days.map((d, i) => {
                const st = dayStats(d);
                const today = isoDate(d) === isoDate(new Date());
                return (
                  <div key={i} style={{ padding: '8px 10px', borderLeft: '1px solid var(--line)', background: today ? 'hsla(var(--color-green),0.06)' : 'transparent' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                      <span style={{ fontSize: 16, fontWeight: 800, color: today ? 'hsl(var(--color-green))' : 'var(--ink)' }}>{d.getDate()}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{d.toLocaleDateString([], { weekday: 'short' })}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{st.people} · {fmtHrs(st.min)}</div>
                  </div>
                );
              })}
            </div>

            {/* Open shifts row (Teams-style): unassigned slots to hand out */}
            <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-green),0.03)' }}>
              <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--card)', border: '1px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', flexShrink: 0 }}>
                  <CalendarRange size={13} />
                </span>
                <span>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>Open shifts</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{openCount} open</div>
                </span>
              </div>
              {days.map((d, di) => {
                const ds = isoDate(d);
                const items = openByDate[ds] || [];
                return (
                  <div key={di} onClick={() => !items.length && setOpenCell({ date: ds })}
                    style={{ borderLeft: '1px solid var(--line)', padding: 4, minHeight: 48, cursor: items.length ? 'default' : 'pointer', position: 'relative' }}
                    className="sched-cell">
                    {items.map(s => (
                      <div key={s.id} onClick={(e) => { e.stopPropagation(); setOpenCell({ date: ds, existing: s }); }}
                        style={{ background: (s.color || '#16a34a') + '18', border: `1px dashed ${s.color || '#16a34a'}`, borderRadius: 6, padding: '5px 8px', marginBottom: 3, cursor: 'pointer' }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#166534', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                          <span>{s.code || 'Open'}</span>
                          {(s.openSlots || 1) > 1 && <span style={{ fontSize: 10, background: '#16a34a', color: '#fff', borderRadius: 10, padding: '0 6px' }}>×{s.openSlots}</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} /> {t12(s.start)}–{t12(s.end)}</div>
                        {s.label && <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>}
                      </div>
                    ))}
                    {!items.length && (
                      <div className="sched-add" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--line)', opacity: 0 }}>
                        <Plus size={16} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Group + employee rows */}
            {groupsView.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>No employees in scope.</div>
            )}
            {groupsView.map((g, gi) => (
              <div key={gi}>
                <div style={{ ...GRID, background: 'var(--bg)', borderBottom: '1px solid var(--line)', borderTop: gi ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ padding: '6px 12px', gridColumn: '1 / -1', fontSize: 12, fontWeight: 800 }}>
                    {g.name} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {g.members.length}</span>
                  </div>
                </div>
                {g.members.map(emp => (
                  <div key={emp.email} style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
                    <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--bg)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: 'var(--muted)', flexShrink: 0 }}>
                        {(emp.name || emp.email).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name || emp.email}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{fmtHrs(empWeekMin(emp.email))}</div>
                      </span>
                    </div>
                    {days.map((d, di) => {
                      const ds = isoDate(d);
                      const items = byCell[`${emp.email}|${ds}`] || [];
                      const off = offOn(emp.email, ds);
                      return (
                        <div key={di} onClick={() => !items.length && setCell({ email: emp.email, date: ds })}
                          style={{ borderLeft: '1px solid var(--line)', padding: 4, minHeight: 54, cursor: items.length ? 'default' : 'pointer', position: 'relative' }}
                          className="sched-cell">
                          {off && !items.length && (
                            <div style={{ background: TYPE_TINT[off.type] || TYPE_TINT.other, borderRadius: 6, padding: '6px 8px', height: '100%' }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#9f1239' }}>{off.status === 'approved' ? 'Off' : 'Requested off'}</div>
                              <div style={{ fontSize: 10, color: '#9f1239' }}>All Day</div>
                            </div>
                          )}
                          {items.map(s => (
                            <div key={s.id} onClick={(e) => { e.stopPropagation(); setCell({ email: emp.email, date: ds, existing: s }); }}
                              style={{ background: (s.color || '#64748b') + '22', borderLeft: `3px solid ${s.color || '#64748b'}`, borderRadius: 6, padding: '5px 8px', marginBottom: 3, cursor: 'pointer' }}>
                              <div style={{ fontSize: 11, fontWeight: 800, color: '#334155' }}>{s.code || 'Shift'}</div>
                              <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} /> {t12(s.start)}–{t12(s.end)}</div>
                              {s.label && <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>}
                            </div>
                          ))}
                          {!items.length && !off && (
                            <div className="sched-add" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--line)', opacity: 0 }}>
                              <Plus size={16} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {cell && (
        <CellModal cell={cell} shifts={data?.shifts || []} busy={busy}
          onSave={saveCell} onDelete={delCell} onClose={() => setCell(null)} />
      )}

      {bulkOpen && (
        <BulkModal groups={data?.groups || []} shifts={data?.shifts || []}
          allEmails={(data?.employees || []).map(e => e.email)}
          defaultStart={start} defaultEnd={end} busy={busy}
          onApply={bulkAssign} onClose={() => setBulkOpen(false)} />
      )}

      {openCell && (
        <OpenShiftModal cell={openCell} shifts={data?.shifts || []} people={data?.employees || []} busy={busy}
          onSave={saveOpen} onAssign={assignOpen} onDelete={delCell} onClose={() => setOpenCell(null)} />
      )}

      <style>{`.sched-cell:hover .sched-add { opacity: 1 !important; }`}</style>
    </div>
  );
}

// Bulk assign: apply a preset to a whole group (or everyone in view) across a
// date range and chosen weekdays in one action, instead of adding a shift per
// person per day. Skips time off and (unless overwrite) days that already have
// a shift, so re-running it is safe.
function BulkModal({ groups, shifts, allEmails, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [groupId, setGroupId] = useState(groups[0]?.id || '');   // '' = everyone in view
  const [shiftId, setShiftId] = useState(shifts[0]?.id || '');
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [dows, setDows] = useState([0, 1, 2, 3, 4]);   // Mon-Fri by default
  const [skipOff, setSkipOff] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const preset = shifts.find(s => s.id === shiftId);
  const DOW = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];
  const toggle = (n) => setDows(d => d.includes(n) ? d.filter(x => x !== n) : [...d, n]);
  const targetCount = groupId ? (groups.find(g => g.id === groupId)?.members?.length || 0) : allEmails.length;
  const canApply = shifts.length > 0 && from && to && dows.length > 0 && !busy && (groupId || allEmails.length);

  function submit() {
    const payload = { shift_id: shiftId, start_date: from, end_date: to, weekdays: dows,
                      skip_timeoff: skipOff, overwrite };
    if (groupId) payload.group_id = groupId; else payload.emails = allEmails;
    onApply(payload);
  }

  const lbl = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Fill schedule</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Apply a shift to a whole group across a date range in one go - no more adding it per person per day.
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & groups” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div style={lbl}>Apply to</div>
              <select className="form-input" value={groupId} onChange={e => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.members?.length || 0})</option>)}
                <option value="">Everyone in view ({allEmails.length})</option>
              </select>
            </div>
            <div>
              <div style={lbl}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => setShiftId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({s.start}–{s.end})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1 }}><div style={lbl}>From</div><input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1 }}><div style={lbl}>To</div><input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            </div>
            <div>
              <div style={lbl}>Days of week</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {DOW.map(([label, n]) => {
                  const on = dows.includes(n);
                  return (
                    <button key={n} type="button" onClick={() => toggle(n)}
                      style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${on ? 'var(--wk-brand, hsl(var(--color-green)))' : 'var(--line)'}`,
                        background: on ? 'hsla(var(--color-green),0.12)' : 'transparent',
                        color: on ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{label}</button>
                  );
                })}
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={skipOff} onChange={e => setSkipOff(e.target.checked)} /> Skip days a person has time off
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Replace shifts that are already there (otherwise keep them)
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {targetCount} {targetCount === 1 ? 'person' : 'people'} · {preset ? `${preset.start}–${preset.end}` : 'preset'} · {dows.length} day{dows.length !== 1 ? 's' : ''}/week
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={!canApply}
            style={{ opacity: canApply ? 1 : 0.55 }}>{busy ? '…' : 'Fill schedule'}</button>}
        </div>
      </div>
    </div>
  );
}

// Open shift editor: create/edit an unassigned slot (preset + how many people
// needed) and, for an existing one, ASSIGN it to a person - which spawns their
// own shift and drops the open count (Teams "Assign open shifts").
function OpenShiftModal({ cell, shifts, people, busy, onSave, onAssign, onDelete, onClose }) {
  const ex = cell.existing;
  const [shiftId, setShiftId] = useState(ex?.shiftId || (shifts[0]?.id || ''));
  const [start, setStart] = useState(ex?.start || '');
  const [end, setEnd] = useState(ex?.end || '');
  const [slots, setSlots] = useState(ex?.openSlots || 1);
  const [label, setLabel] = useState(ex?.label || '');
  const [assignee, setAssignee] = useState('');
  const preset = shifts.find(s => s.id === shiftId);
  const eff = (v, p) => v || p || '';

  function submit() {
    onSave({ id: ex?.id, work_date: cell.date, shift_id: shiftId,
      start_hhmm: eff(start, preset?.start), end_hhmm: eff(end, preset?.end),
      label, open_slots: Math.max(1, Number(slots) || 1) });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 430, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{ex ? 'Open shift' : 'Add open shift'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {new Date(cell.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · an unassigned slot anyone on the team can be given
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & groups” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => { setShiftId(e.target.value); setStart(''); setEnd(''); }} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({s.start}–{s.end})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={eff(start, preset?.start)} onChange={e => setStart(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={eff(end, preset?.end)} onChange={e => setEnd(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ width: 80, fontSize: 11, color: 'var(--muted)' }}>People<input type="number" min={1} max={50} className="form-input" value={slots} onChange={e => setSlots(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            </div>
            <input className="form-input" placeholder="Label (e.g. All Properties)" value={label} onChange={e => setLabel(e.target.value)} style={{ fontSize: 13 }} />

            {ex && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 700 }}>Assign to a person</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="form-input" value={assignee} onChange={e => setAssignee(e.target.value)} style={{ flex: 1, fontSize: 13 }}>
                    <option value="">- pick someone -</option>
                    {people.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
                  </select>
                  <button className="secondary-btn" onClick={() => assignee && onAssign(ex.id, assignee)} disabled={!assignee || busy}
                    style={{ opacity: assignee ? 1 : 0.55 }}>Assign</button>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>Gives this shift to the person and drops the open count by one.</div>
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {ex && <button onClick={() => onDelete(ex.id)} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={13} /> Remove</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={busy}>{busy ? '…' : 'Save'}</button>}
        </div>
      </div>
    </div>
  );
}

function CellModal({ cell, shifts, busy, onSave, onDelete, onClose }) {
  const ex = cell.existing;
  const [shiftId, setShiftId] = useState(ex?.shiftId || (shifts[0]?.id || ''));
  const [start, setStart] = useState(ex?.start || '');
  const [end, setEnd] = useState(ex?.end || '');
  const [label, setLabel] = useState(ex?.label || '');
  const [note, setNote] = useState(ex?.note || '');
  const preset = shifts.find(s => s.id === shiftId);
  const eff = (v, p) => v || p || '';

  function submit() {
    onSave({
      id: ex?.id, employee_email: cell.email, work_date: cell.date, shift_id: shiftId,
      start_hhmm: eff(start, preset?.start), end_hhmm: eff(end, preset?.end),
      label, note,
    });
  }

  // ex is fixed for this modal instance's lifetime (a fresh CellModal mounts
  // per cell click), so the initial useState values ARE the baseline.
  const dirty = shiftId !== (ex?.shiftId || (shifts[0]?.id || '')) || start !== (ex?.start || '')
    || end !== (ex?.end || '') || label !== (ex?.label || '') || note !== (ex?.note || '');
  const guard = useUnsavedGuard(dirty, onClose, submit);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 'clamp(420px, 60vw, 700px)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{ex ? 'Edit Shift' : 'Add Shift'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {new Date(cell.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
        </div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift presets yet - create one under “Presets & groups” first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Shift preset</div>
              <select className="form-input" value={shiftId} onChange={e => { setShiftId(e.target.value); setStart(''); setEnd(''); }} style={{ width: '100%', fontSize: 13 }}>
                {shifts.map(s => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({s.start}–{s.end})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={eff(start, preset?.start)} onChange={e => setStart(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={eff(end, preset?.end)} onChange={e => setEnd(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            </div>
            <input className="form-input" placeholder="Label (e.g. All Properties)" value={label} onChange={e => setLabel(e.target.value)} style={{ fontSize: 13 }} />
            <input className="form-input" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} style={{ fontSize: 13 }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {ex && <button onClick={() => onDelete(ex.id)} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={13} /> Remove</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button className="primary-btn" onClick={submit} disabled={busy}>{busy ? '…' : 'Save'}</button>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </div>
  );
}
