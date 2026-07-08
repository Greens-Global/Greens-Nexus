import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock, ChevronDown, ChevronRight, ChevronLeft, MapPin, AlertTriangle, Download,
  Pencil, Plus, Loader2, X, CheckCircle, Ban,
} from 'lucide-react';
import { api } from '../api';
import DayTimeline from './DayTimeline';
import DayActivity from './DayActivity';
import ShiftsPanel from './ShiftsPanel';
import ShiftSchedule from './ShiftSchedule';
import PayrollTimecard from './PayrollTimecard';

const TYPE_COLOR = { vacation: '#2563eb', sick: '#16a34a', personal: '#8b5cf6', unpaid: '#6b7280', other: '#f59e0b' };

// ── HR → Time: team timesheets, corrections, payroll export ──────────────────
// Single-screen review (the SwipeClock manager expectation): every employee's
// totals for the range, expandable to day → punch level with geofence status
// and a map pin per located punch. Corrections freeze the original time and
// stamp who adjusted; voids hide from totals but stay in the record.

const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break start', break_end: 'Break end' };
const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const isoDate = (d) => d.toISOString().slice(0, 10);

// One day inside the person drawer — click to reveal the working/idle
// breakdown and the desktop agent's app/window log for that day.
function AdminDayRow({ date, email, d }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
        <span style={{ fontSize: 12, fontWeight: 800, width: 92, flexShrink: 0, color: 'var(--ink)' }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <DayTimeline punches={d.punches} height={18} />
        {d.flags.length > 0 && <AlertTriangle size={12} style={{ color: '#b45309', flexShrink: 0 }} />}
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--pine)', width: 58, textAlign: 'right', flexShrink: 0 }}>{fmtMin(d.workedMin)}</span>
      </button>
      {d.flags.length > 0 && (
        <div style={{ fontSize: 10, fontWeight: 700, color: '#b45309', marginTop: 3, marginLeft: 102, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          {d.flags.map(f => f.replace(/_/g, ' ')).join(' · ')}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 8, marginLeft: 8 }}>
          <DayActivity date={date} email={email} />
        </div>
      )}
    </div>
  );
}
const utcToInput = (iso) => {
  const d = new Date(iso + 'Z');
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function weekRange(offset = 0) {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [isoDate(mon), isoDate(sun)];
}

const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase' };

export default function TimeAdmin({ employees = [], toastOk, toastErr }) {
  const [view, setView] = useState('timecards');   // timecards | timeoff
  const [[start, end], setRange] = useState(() => weekRange(0));
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});          // email -> bool
  const [edit, setEdit] = useState(null);        // punch being edited
  const [addFor, setAddFor] = useState(null);    // email getting a manual punch
  const [addP, setAddP] = useState({ kind: 'out', at: '', note: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setRows(null);
    api.timeTeam(start, end).then(r => setRows(r.rows)).catch(e => { setRows([]); toastErr(e?.message || 'Could not load timesheets.'); });
  }, [start, end, toastErr]);
  useEffect(() => { load(); }, [load]);

  const [timeoff, setTimeoff] = useState([]);
  const loadTimeoff = useCallback(() => {
    api.timeOffList().then(setTimeoff).catch(() => setTimeoff([]));
  }, []);
  useEffect(() => { loadTimeoff(); }, [loadTimeoff]);

  const [attMonth, setAttMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const shiftMonth = (delta) => {
    const [y, m] = attMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setAttMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  async function approveRow(email) {
    try { await api.timeApprove({ email, start, end }); toastOk('Timecard approved — the employee gets a notification.'); load(); }
    catch (e) { toastErr(e?.message || 'Could not approve.'); }
  }
  const [approvingAll, setApprovingAll] = useState(false);
  async function approveAll() {
    const targets = (rows || []).filter(r => !r.approval);
    if (!targets.length || approvingAll) return;
    setApprovingAll(true);
    let ok = 0;
    for (const r of targets) { // sequential — one bell per person, no request race
      try { await api.timeApprove({ email: r.email, start, end }); ok++; }
      catch { /* keep going; the count tells the story */ }
    }
    toastOk(`Approved ${ok} of ${targets.length} timecard${targets.length === 1 ? '' : 's'}.`);
    setApprovingAll(false);
    load();
  }
  const [person, setPerson] = useState(null);   // employee drill-down (their time portal)
  const [personAct, setPersonAct] = useState(null);   // app-usage for that person
  const [shiftMode, setShiftMode] = useState('schedule'); // schedule | presets

  useEffect(() => {
    if (!person) { setPersonAct(null); return; }
    let live = true;
    setPersonAct(null);
    api.timeActivity(person.email, start, end)
      .then(r => { if (live) setPersonAct(r); })
      .catch(() => { if (live) setPersonAct({ apps: [], totalSeconds: 0, activePct: 0 }); });
    return () => { live = false; };
  }, [person, start, end]);
  async function revokeApproval(id) {
    try { await api.timeApprovalRevoke(id); toastOk('Approval revoked.'); load(); }
    catch (e) { toastErr(e?.message || 'Could not revoke.'); }
  }

  async function decideTimeoff(id, status) {
    const note = status === 'rejected' ? (window.prompt('Reason (sent to the employee):') || '') : '';
    try {
      await api.timeOffDecide(id, { status, note });
      toastOk(`Request ${status}.`);
      loadTimeoff();
    } catch (e) { toastErr(e?.message || 'Could not update the request.'); }
  }

  async function exportCsv(mode) {
    try {
      const blob = await api.timeExportCsv(start, end, mode);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `timeclock-${mode}-${start}-to-${end}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toastErr(e?.message || 'Export failed.'); }
  }

  async function saveEdit() {
    if (busy) return; setBusy(true);
    try {
      await api.timeAdjustPunch(edit.id, {
        at: edit.atInput ? new Date(edit.atInput).toISOString().slice(0, 19) : undefined,
        note: edit.note, void: edit.voided, adjust_note: edit.adjustNote || '',
      });
      toastOk('Punch updated — the original time stays on record.');
      setEdit(null); load();
    } catch (e) { toastErr(e?.message || 'Could not update the punch.'); }
    setBusy(false);
  }

  async function saveAdd() {
    if (busy) return;
    if (!addP.at) { toastErr('Pick the punch time.'); return; }
    setBusy(true);
    try {
      await api.timeAddPunch({ employee_email: addFor, kind: addP.kind,
        at: new Date(addP.at).toISOString().slice(0, 19),
        tz_offset_min: new Date().getTimezoneOffset(), note: addP.note });
      toastOk('Punch added.');
      setAddFor(null); setAddP({ kind: 'out', at: '', note: '' }); load();
    } catch (e) { toastErr(e?.message || 'Could not add the punch.'); }
    setBusy(false);
  }

  const totalMin = (rows || []).reduce((a, r) => a + r.workedMin, 0);
  const totalFlags = (rows || []).reduce((a, r) => a + r.flagCount, 0);
  const pendingCount = timeoff.filter(r => r.status === 'pending').length;
  const approvedCount = (rows || []).filter(r => r.approval).length;

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* KPI strip — the at-a-glance row (TrackingTime-style status header) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[['Team hours', fmtMin(totalMin), 'var(--pine)'],
          ['Approved', `${approvedCount}/${(rows || []).length}`, approvedCount === (rows || []).length && rows?.length ? 'hsl(var(--color-green))' : 'var(--ink)'],
          ['Punch flags', String(totalFlags), totalFlags ? '#b45309' : 'var(--muted)'],
          ['Time off pending', String(pendingCount), pendingCount ? '#b45309' : 'var(--muted)']].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div className="chip-row scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[['timecards', 'Timecards'], ['attendance', 'Attendance'], ['insights', 'Insights'],
          ['shifts', 'Shifts'], ['payroll', 'Payroll'],
          ['timeoff', `Time off${pendingCount ? ` (${pendingCount})` : ''}`]].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            style={{ padding: '6px 15px', borderRadius: 10, border: `1px solid ${view === key ? 'var(--pine)' : 'var(--line)'}`,
              background: view === key ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
              color: view === key ? 'hsl(var(--color-green))' : 'var(--muted)',
              fontWeight: view === key ? 700 : 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Range + export bar (shared by Timecards and Insights) */}
      {(view === 'timecards' || view === 'insights') && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {[['This week', 0], ['Last week', -1]].map(([l, off]) => {
          const r = weekRange(off);
          const active = r[0] === start && r[1] === end;
          return (
            <button key={l} className="secondary-btn" onClick={() => setRange(r)}
              style={{ fontSize: 12, ...(active ? { background: 'var(--pine)', color: '#fff', borderColor: 'var(--pine)' } : {}) }}>{l}</button>
          );
        })}
        <input className="form-input" type="date" value={start} onChange={e => setRange([e.target.value, end])} style={{ fontSize: 12, width: 150 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
        <input className="form-input" type="date" value={end} onChange={e => setRange([start, e.target.value])} style={{ fontSize: 12, width: 150 }} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>Team total: <span style={{ color: 'var(--pine)' }}>{fmtMin(totalMin)}</span></span>
        {(rows || []).some(r => !r.approval) && (
          <button className="primary-btn" onClick={approveAll} disabled={approvingAll}
            title="Approve every unapproved timecard in this period"
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {approvingAll ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={12} />}
            Approve all ({(rows || []).filter(r => !r.approval).length})
          </button>
        )}
        <button className="secondary-btn" onClick={() => exportCsv('summary')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> Summary CSV
        </button>
        <button className="secondary-btn" onClick={() => exportCsv('punches')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> All punches CSV
        </button>
      </div>
      )}

      {view === 'timecards' && (<>
      {rows === null && <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12 }}>
          No punches in this range. Employees punch in from the Time Clock page in the sidebar.
        </div>
      )}

      {(rows || []).map(r => (
        <div key={r.email} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
          <div onClick={() => setOpen(o => ({ ...o, [r.email]: !o[r.email] }))} role="button"
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            {open[r.email] ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
            <button onClick={e => { e.stopPropagation(); setPerson(r); }} title="Open their time profile"
              style={{ fontSize: 13, fontWeight: 800, flex: '0 0 200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, fontFamily: 'Inter,sans-serif',
                color: 'var(--pine)', textDecoration: 'underline', textDecorationColor: 'transparent', textUnderlineOffset: 3 }}
              onMouseEnter={e => { e.currentTarget.style.textDecorationColor = 'var(--pine)'; }}
              onMouseLeave={e => { e.currentTarget.style.textDecorationColor = 'transparent'; }}>{r.name}</button>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
            {r.flagCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: '#b45309' }}>
                <AlertTriangle size={11} /> {r.flagCount}
              </span>
            )}
            {r.breakMin > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.breakMin}m break</span>}
            {r.approval ? (
              <span title={`Approved by ${r.approval.by} · ${(r.approval.at || '').slice(0, 16).replace('T', ' ')}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.1)', padding: '3px 9px', borderRadius: 10 }}>
                <CheckCircle size={11} /> APPROVED
                <button onClick={e => { e.stopPropagation(); revokeApproval(r.approval.id); }} title="Revoke approval"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex', padding: 0, marginLeft: 2 }}><X size={10} /></button>
              </span>
            ) : (
              <button className="primary-btn" onClick={e => { e.stopPropagation(); approveRow(r.email); }}
                title="Sign off this timecard for the selected period"
                style={{ fontSize: 11, padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle size={11} /> Approve
              </button>
            )}
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--pine)', width: 62, textAlign: 'right' }}>{fmtMin(r.workedMin)}</span>
          </div>

          {open[r.email] && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '10px 14px 12px 38px' }}>
              {Object.keys(r.days).sort().map(date => {
                const d = r.days[date];
                return (
                  <div key={date} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800 }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtMin(d.workedMin)}{d.breakMin ? ` · ${d.breakMin}m break` : ''}</span>
                      {d.flags.map(f => <span key={f} style={{ fontSize: 10, fontWeight: 800, color: '#b45309', textTransform: 'uppercase' }}>{f.replace(/_/g, ' ')}</span>)}
                    </div>
                    <div style={{ margin: '5px 0 4px', maxWidth: 560 }}><DayTimeline punches={d.punches} height={18} /></div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {d.punches.map(p => (
                        <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '4px 10px', borderRadius: 10,
                          background: p.voided ? 'transparent' : p.geoStatus === 'out_of_fence' ? 'rgba(180,83,9,0.1)' : 'var(--mist)',
                          border: '1px solid var(--line)', color: p.voided ? 'var(--line)' : 'var(--ink)',
                          textDecoration: p.voided ? 'line-through' : 'none' }}>
                          <b>{KIND_LABEL[p.kind]}</b> {localTime(p.at)}
                          {p.originalAt && <span title={`Originally ${localTime(p.originalAt)} — adjusted by ${p.adjustedBy}`} style={{ color: '#b45309', fontWeight: 700 }}>✎</span>}
                          {p.lat && (
                            <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer"
                              title={`${p.geoStatus === 'in_fence' ? `At ${p.workSiteName}` : `${p.distanceM}m from ${p.workSiteName || 'nearest site'}`} (±${p.accuracyM}m)`}
                              style={{ display: 'inline-flex', color: p.geoStatus === 'out_of_fence' ? '#b45309' : p.geoStatus === 'in_fence' ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                              <MapPin size={11} />
                            </a>
                          )}
                          {p.source !== 'web' && <span title={p.source === 'self_manual' ? `Self-corrected: ${p.note}` : `Added by ${p.createdBy}`} style={{ fontSize: 10, fontWeight: 800, color: '#b45309' }}>M</span>}
                          <button onClick={() => setEdit({ ...p, atInput: utcToInput(p.at), adjustNote: '' })} title="Adjust / void"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 1 }}>
                            <Pencil size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button className="secondary-btn" onClick={() => { setAddFor(r.email); setAddP({ kind: 'out', at: '', note: '' }); }}
                style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Plus size={11} /> Add punch
              </button>
            </div>
          )}
        </div>
      ))}
      </>)}

      {/* Attendance — month calendar with leave bars (TrackingTime overview) */}
      {view === 'attendance' && (() => {
        const [y, m] = attMonth.split('-').map(Number);
        const daysIn = new Date(y, m, 0).getDate();
        const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday-start
        const cells = [...Array(offset).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];
        const leaves = timeoff.filter(r => r.status === 'approved' || r.status === 'pending');
        const onDay = (n) => {
          const ds = `${attMonth}-${String(n).padStart(2, '0')}`;
          return leaves.filter(r => r.startDate <= ds && ds <= r.endDate);
        };
        const today = new Date().toISOString().slice(0, 10);
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button className="secondary-btn" onClick={() => shiftMonth(-1)} style={{ padding: '4px 8px' }}><ChevronLeft size={13} /></button>
              <span style={{ fontSize: 14, fontWeight: 800, width: 150, textAlign: 'center' }}>
                {new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}
              </span>
              <button className="secondary-btn" onClick={() => shiftMonth(1)} style={{ padding: '4px 8px' }}><ChevronRight size={13} /></button>
              <div style={{ flex: 1 }} />
              {Object.entries(TYPE_COLOR).map(([t, c]) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--muted)', textTransform: 'capitalize' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} /> {t}
                </span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                <div key={d} style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', padding: '2px 6px' }}>{d}</div>
              ))}
              {cells.map((n, i) => {
                if (n === null) return <div key={`e${i}`} />;
                const ds = `${attMonth}-${String(n).padStart(2, '0')}`;
                const entries = onDay(n);
                return (
                  <div key={n} style={{ minHeight: 72, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 6px',
                    background: ds === today ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 800, color: ds === today ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{n}</div>
                    {entries.slice(0, 3).map(r => (
                      <div key={r.id} title={`${r.name || r.email} — ${r.type} ${r.startDate} → ${r.endDate}${r.status === 'pending' ? ' (pending)' : ''}`}
                        style={{ fontSize: 9.5, fontWeight: 700, color: '#fff', background: TYPE_COLOR[r.type] || '#6b7280',
                          borderRadius: 4, padding: '1px 5px', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          opacity: r.status === 'pending' ? 0.55 : 1 }}>
                        {(r.name || r.email).split(' ')[0]}
                      </div>
                    ))}
                    {entries.length > 3 && <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>+{entries.length - 3} more</div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Insights — hours by person + daily team hours, straight off the range */}
      {view === 'insights' && (rows === null
        ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : (() => {
          const sorted = [...rows].sort((a, b) => b.workedMin - a.workedMin);
          const maxWork = Math.max(1, ...rows.map(r => r.workedMin));
          const dayTotals = {};
          rows.forEach(r => Object.entries(r.days).forEach(([d, v]) => { dayTotals[d] = (dayTotals[d] || 0) + v.workedMin; }));
          const dates = Object.keys(dayTotals).sort();
          const maxDay = Math.max(1, ...Object.values(dayTotals));
          return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>Hours by person</div>
                {sorted.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No hours in this range.</div>}
                {sorted.map(r => (
                  <div key={r.email} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700 }}>{r.name}</span>
                      <span style={{ fontWeight: 800, color: 'var(--pine)' }}>{fmtMin(r.workedMin)}</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--mist)', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.workedMin / maxWork) * 100}%`, height: '100%', background: 'var(--pine)', borderRadius: 6, transition: 'width .4s ease' }} />
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>Daily team hours</div>
                {dates.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No hours in this range.</div>}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140 }}>
                  {dates.map(d => (
                    <div key={d} title={`${d} — ${fmtMin(dayTotals[d])}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                      <div style={{ width: '70%', maxWidth: 38, height: `${Math.max(4, (dayTotals[d] / maxDay) * 110)}px`, background: 'var(--pine)', borderRadius: '6px 6px 2px 2px', opacity: 0.9 }} />
                      <span style={{ fontSize: 9.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short' })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })())}

      {/* Shifts — weekly schedule grid + preset/group manager */}
      {view === 'shifts' && (
        <>
          <div className="chip-row" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {[['schedule', 'Schedule'], ['presets', 'Presets & groups']].map(([key, label]) => (
              <button key={key} onClick={() => setShiftMode(key)}
                style={{ padding: '5px 13px', borderRadius: 9, border: `1px solid ${shiftMode === key ? 'var(--pine)' : 'var(--line)'}`,
                  background: shiftMode === key ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
                  color: shiftMode === key ? 'hsl(var(--color-green))' : 'var(--muted)',
                  fontWeight: shiftMode === key ? 700 : 600, fontSize: 12, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                {label}
              </button>
            ))}
          </div>
          {shiftMode === 'schedule'
            ? <ShiftSchedule toastOk={toastOk} toastErr={toastErr} />
            : <ShiftsPanel
                people={employees.length ? employees : (rows || []).map(r => ({ email: r.email, name: r.name }))}
                toastOk={toastOk} toastErr={toastErr} />}
        </>
      )}

      {/* Payroll — per-employee, per-pay-period editable timecard */}
      {view === 'payroll' && <PayrollTimecard toastOk={toastOk} toastErr={toastErr} />}

      {/* Time-off register — requests table, pending rows carry the decisions */}
      {view === 'timeoff' && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--line)', fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            <span>Requested by</span><span>Type</span><span>Period</span><span>Days</span><span>Approver</span><span style={{ textAlign: 'right' }}>Status</span>
          </div>
          {timeoff.length === 0 && (
            <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>No time-off requests yet.</div>
          )}
          {timeoff.map(r => {
            const days = Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1;
            return (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: r.status === 'pending' ? 'rgba(251,191,36,0.05)' : 'transparent' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.email}</span>
                <span style={{ fontSize: 12, textTransform: 'capitalize' }}>{r.type}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }} title={r.note}>{r.startDate} → {r.endDate}{r.note ? ' · “' + r.note + '”' : ''}</span>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{isNaN(days) ? '—' : days}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.approver || '—'}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  {r.status === 'pending' ? (<>
                    <button className="secondary-btn" onClick={() => decideTimeoff(r.id, 'rejected')} style={{ fontSize: 11, color: '#b91c1c', padding: '4px 10px' }}>Reject</button>
                    <button className="primary-btn" onClick={() => decideTimeoff(r.id, 'approved')} style={{ fontSize: 11, padding: '4px 10px' }}>Approve</button>
                  </>) : (
                    <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em',
                      color: r.status === 'approved' ? 'hsl(var(--color-green))' : r.status === 'rejected' ? '#b91c1c' : 'var(--muted)' }}>
                      {r.status}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Person time portal — everything time-related for one employee.
          Portaled to <body>: host cards (Manager Dashboard) have transformed
          ancestors that would otherwise trap position:fixed overlays. */}
      {person && createPortal((() => {
        const p = (rows || []).find(r => r.email === person.email) || person;
        const myOff = timeoff.filter(t => t.email === p.email);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => e.target === e.currentTarget && setPerson(null)}>
            <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 780, maxHeight: 'min(92dvh, 720px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>
                  {p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email} · {start} → {end}</div>
                </div>
                {p.approval
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.1)', padding: '4px 11px', borderRadius: 10 }}><CheckCircle size={12} /> APPROVED</span>
                  : <button className="primary-btn" onClick={() => { approveRow(p.email); setPerson(null); }} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><CheckCircle size={12} /> Approve period</button>}
                <button onClick={() => setPerson(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 16 }}>
                  {[['Worked', fmtMin(p.workedMin), 'var(--pine)'],
                    ['Breaks', `${p.breakMin}m`, 'var(--ink)'],
                    ['Days', String(Object.keys(p.days || {}).length), 'var(--ink)'],
                    ['Flags', String(p.flagCount), p.flagCount ? '#b45309' : 'var(--muted)']].map(([l, v, c]) => (
                    <div key={l} style={{ background: 'var(--mist)', borderRadius: 10, padding: '10px 14px' }}>
                      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{l}</div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: c }}>{v}</div>
                    </div>
                  ))}
                </div>

                {Object.keys(p.days || {}).length > 1 && (() => {
                  const dts = Object.keys(p.days).sort();
                  const mx = Math.max(1, ...dts.map(d => p.days[d].workedMin));
                  return (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Daily hours</div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 90 }}>
                        {dts.map(d => (
                          <div key={d} title={`${d} — ${fmtMin(p.days[d].workedMin)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
                            <div style={{ width: '65%', maxWidth: 34, height: `${Math.max(4, (p.days[d].workedMin / mx) * 66)}px`, background: 'var(--pine)', borderRadius: '5px 5px 2px 2px', opacity: 0.9 }} />
                            <span style={{ fontSize: 9, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short' })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
                  Days <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>— click one for the working/idle + app breakdown</span>
                </div>
                {Object.keys(p.days || {}).sort().map(date => (
                  <AdminDayRow key={date} date={date} email={p.email} d={p.days[date]} />
                ))}
                {Object.keys(p.days || {}).length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No punches in this range.</div>}

                {/* App usage — from the desktop agent's activity tracking */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 8px' }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>App usage</span>
                  {personAct && personAct.totalSeconds > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-green))' }}>{personAct.activePct}% active</span>
                  )}
                </div>
                {personAct === null ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /></div>
                ) : personAct.totalSeconds === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>No app activity — this person isn’t on the desktop agent (or hasn’t worked in this range).</div>
                ) : (() => {
                  const mx = Math.max(1, ...personAct.apps.map(a => a.seconds));
                  const hm = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.max(1, Math.round(s / 60))}m`;
                  return personAct.apps.map(a => (
                    <div key={a.app} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>{a.app}</span>
                        <span style={{ fontWeight: 700, color: 'var(--muted)' }}>{hm(a.seconds)}</span>
                      </div>
                      <div style={{ height: 7, background: 'var(--mist)', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{ width: `${(a.seconds / mx) * 100}%`, height: '100%', background: 'var(--pine)', borderRadius: 5 }} />
                      </div>
                    </div>
                  ));
                })()}

                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', margin: '18px 0 8px' }}>Time off</div>
                {myOff.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No requests on record.</div>}
                {myOff.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, textTransform: 'capitalize', width: 80 }}>{t.type}</span>
                    <span style={{ color: 'var(--muted)', flex: 1 }}>{t.startDate} → {t.endDate}{t.note ? ` · “${t.note}”` : ''}</span>
                    <span style={{ fontWeight: 800, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em',
                      color: t.status === 'approved' ? 'hsl(var(--color-green))' : t.status === 'rejected' ? '#b91c1c' : '#b45309' }}>{t.status}</span>
                  </div>
                ))}
                <p style={{ margin: '14px 0 0', fontSize: 10.5, color: 'var(--muted)' }}>
                  To correct a punch, use the pencil on the Timecards list. Screenshots (if captured) are under your profile → Admin → Screenshots.
                </p>
              </div>
            </div>
          </div>
        );
      })(), document.body)}

      {/* Edit punch modal */}
      {edit && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setEdit(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 430, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clock size={15} style={{ color: 'var(--pine)' }} />
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Adjust punch — {KIND_LABEL[edit.kind]}</h3>
              <button onClick={() => setEdit(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              {edit.originalAt && (
                <p style={{ margin: 0, fontSize: 11.5, color: '#b45309' }}>Original time on record: {localTime(edit.originalAt)} (adjusted by {edit.adjustedBy})</p>
              )}
              <div><label style={FL}>Time</label>
                <input className="form-input" type="datetime-local" value={edit.atInput}
                  onChange={e => setEdit(x => ({ ...x, atInput: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Punch note</label>
                <input className="form-input" value={edit.note || ''} onChange={e => setEdit(x => ({ ...x, note: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Reason for adjustment</label>
                <input className="form-input" placeholder="Shows in the audit trail" value={edit.adjustNote}
                  onChange={e => setEdit(x => ({ ...x, adjustNote: e.target.value }))} style={{ width: '100%' }} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!edit.voided} onChange={e => setEdit(x => ({ ...x, voided: e.target.checked }))}
                  style={{ width: 15, height: 15, accentColor: '#b91c1c' }} />
                <Ban size={13} style={{ color: '#b91c1c' }} /> Void this punch (kept on record, excluded from totals)
              </label>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveEdit} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={13} />} Save
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Add punch modal */}
      {addFor && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setAddFor(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 430, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Plus size={15} style={{ color: 'var(--pine)' }} />
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add punch — {addFor}</h3>
              <button onClick={() => setAddFor(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              <div><label style={FL}>Kind</label>
                <select className="form-input" value={addP.kind} onChange={e => setAddP(p => ({ ...p, kind: e.target.value }))} style={{ width: '100%' }}>
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
              <div><label style={FL}>Time</label>
                <input className="form-input" type="datetime-local" value={addP.at} onChange={e => setAddP(p => ({ ...p, at: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Note</label>
                <input className="form-input" placeholder="e.g. forgot to punch out" value={addP.note}
                  onChange={e => setAddP(p => ({ ...p, note: e.target.value }))} style={{ width: '100%' }} /></div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setAddFor(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveAdd} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={13} />} Add
              </button>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}
