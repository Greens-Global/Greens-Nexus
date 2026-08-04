import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock, ChevronDown, ChevronRight, ChevronLeft, MapPin, AlertTriangle, Download,
  Pencil, Plus, Loader2, X, CheckCircle, Ban, Camera, MoonStar,
  CalendarDays, Activity, Inbox, CalendarClock, Banknote, CalendarOff,
} from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import DayTimeline from './DayTimeline';
import ShiftsPanel from './ShiftsPanel';
import ShiftSchedule from './ShiftSchedule';
import PayrollTimecard from './PayrollTimecard';
import TimeInsights from './TimeInsights';
import ImageLightbox from './ImageLightbox';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { ErrorBanner } from './AsyncState';

const TYPE_COLOR = { vacation: '#2563eb', sick: '#16a34a', personal: '#8b5cf6', unpaid: '#6b7280', other: '#f59e0b' };

// ── HR → Time: team timesheets, corrections, payroll export ──────────────────
// Single-screen review (the SwipeClock manager expectation): every employee's
// totals for the range, expandable to day → punch level with geofence status
// and a map pin per located punch. Corrections freeze the original time and
// stamp who adjusted; voids hide from totals but stay in the record.

const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break start', break_end: 'Break end' };
const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '-';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const isoDate = (d) => d.toISOString().slice(0, 10);

// One day inside the person drawer - click to reveal the working/idle
// breakdown and the desktop agent's app/window log for that day.
function AdminDayRow({ date, email, d, approval, onApprove }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontFamily: 'var(--wk-font)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, width: 92, flexShrink: 0, color: 'var(--ink)' }}>{new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <DayTimeline punches={d.punches} height={18} date={date} />
        {d.flags.length > 0 && <AlertTriangle size={12} style={{ color: '#b45309', flexShrink: 0 }} />}
        {onApprove && (
          approval && !approval.stale ? (
            <span title={`Approved by ${approval.by} · ${(approval.at || '').slice(0, 16).replace('T', ' ')}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.1)', padding: '2px 9px', borderRadius: 999, flexShrink: 0 }}>
              <CheckCircle size={10} /> OK
            </span>
          ) : approval?.stale ? (
            <span onClick={e => { e.stopPropagation(); onApprove(); }} role="button" title="Punches changed after sign-off - click to re-approve this day"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: '#b45309', background: 'rgba(180,83,9,0.1)', padding: '2px 9px', borderRadius: 999, flexShrink: 0, cursor: 'pointer' }}>
              <AlertTriangle size={10} /> Re-approve
            </span>
          ) : (
            <span onClick={e => { e.stopPropagation(); onApprove(); }} role="button" title="Sign off this day"
              style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand)', border: '1px solid var(--wk-brand)', padding: '2px 9px', borderRadius: 999, flexShrink: 0, cursor: 'pointer' }}>
              Approve
            </span>
          )
        )}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', width: 58, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtMin(d.workedMin)}</span>
      </button>
      {d.flags.length > 0 && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginTop: 3, marginLeft: 102 }}>
          {d.flags.map(f => f.replace(/_/g, ' ')).join(' · ')}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 8, marginLeft: 102, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
          {(d.punches || []).length === 0 ? (
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No punches this day.</span>
          ) : (d.punches || []).map((p, i) => (
            <span key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              <span style={{ fontWeight: 700, color: 'var(--ink)', textTransform: 'capitalize' }}>{String(p.kind || '').replace(/_/g, ' ')}</span>
              {' '}{(() => { try { return new Date(p.at + (p.at.endsWith('Z') ? '' : 'Z')).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return p.at; } })()}
            </span>
          ))}
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

// Form label + card-header title (Work OS grammar - sentence case, no tracking).
const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };

export default function TimeAdmin({ employees = [], toastOk, toastErr }) {
  const [view, setView] = useState('payroll');   // payroll (the timecard) | attendance | insights | requests | screenshots | shifts | timeoff
  // Live map tab removed Aug 4 - superseded by the top-level Locations map.
  const [payrollEmail, setPayrollEmail] = useState('');   // preselect a person in the Payroll view (from the "to review" badge)
  const [[start, end], setRange] = useState(() => weekRange(0));
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});          // email -> bool
  const [edit, setEdit] = useState(null);        // punch being edited
  const [addFor, setAddFor] = useState(null);    // email getting a manual punch
  const [addP, setAddP] = useState({ kind: 'out', at: '', note: '' });
  const [busy, setBusy] = useState(false);

  // `quiet` keeps the current rows on screen during a refetch (after an approve/edit/
  // add) instead of collapsing the whole list + KPI strip to a spinner on every action.
  const load = useCallback((quiet = false) => {
    if (!quiet) setRows(null);
    api.timeTeam(start, end).then(r => setRows(r.rows)).catch(e => { setRows([]); toastErr(e?.message || 'Could not load timesheets.'); });
  }, [start, end, toastErr]);
  useEffect(() => { load(); }, [load]);
  // A punch add/remove/edit anywhere (this tab or the employee's own timecard) should
  // refresh the team rows so the two views never silently disagree.
  useEffect(() => {
    const onChange = () => load(true);
    window.addEventListener('nexus:timeclock-changed', onChange);
    return () => window.removeEventListener('nexus:timeclock-changed', onChange);
  }, [load]);

  const [timeoff, setTimeoff] = useState([]);
  const [timeoffErr, setTimeoffErr] = useState(false);
  const loadTimeoff = useCallback(() => {
    setTimeoffErr(false);
    api.timeOffList().then(r => { setTimeoff(r); }).catch(() => setTimeoffErr(true));   // don't mask a failure as "no requests"
  }, []);
  useEffect(() => { loadTimeoff(); }, [loadTimeoff]);

  const [attMonth, setAttMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const shiftMonth = (delta) => {
    const [y, m] = attMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setAttMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  // Per-day approvals: a day is "approved" only while its punches are untouched -
  // any add/adjust after sign-off marks it stale and it must be re-approved.
  const isRowApproved = (r) => {
    const dk = Object.keys(r.days || {});
    const da = r.dayApprovals || {};
    const legacyOk = r.approval && !r.approval.stale;
    return legacyOk || (dk.length > 0 && dk.every(d => da[d] && !da[d].stale));
  };
  const rowStale = (r) => r.approval?.stale || Object.values(r.dayApprovals || {}).some(a => a.stale);

  async function approveDays(email, daysArr, quiet = false) {
    if (!daysArr.length) { toastErr('No worked days in this period to approve.'); return; }
    try {
      await api.timeApprove({ email, days: daysArr });
      if (!quiet) toastOk(daysArr.length === 1 ? 'Day approved - the employee gets a notification.' : `Approved ${daysArr.length} days - the employee gets a notification.`);
      load(true);
    } catch (e) { toastErr(e?.message || 'Could not approve.'); }
  }
  const [approvingAll, setApprovingAll] = useState(false);
  async function approveAll() {
    const targets = (rows || []).filter(r => !isRowApproved(r) && Object.keys(r.days || {}).length);
    if (!targets.length || approvingAll) return;
    setApprovingAll(true);
    let ok = 0;
    for (const r of targets) { // sequential - one bell per person, no request race
      try { await api.timeApprove({ email: r.email, days: Object.keys(r.days) }); ok++; }
      catch { /* keep going; the count tells the story */ }
    }
    toastOk(`Approved ${ok} of ${targets.length} timecard${targets.length === 1 ? '' : 's'}.`);
    setApprovingAll(false);
    load(true);
  }
  const [person, setPerson] = useState(null);   // employee drill-down (their time portal)
  const [shiftMode, setShiftMode] = useState('schedule'); // schedule | presets

  // Disclosed-monitoring: manager-scoped screenshot gallery (team-scoped API).
  const [shotDate, setShotDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shotPeople, setShotPeople] = useState(null);
  const [shotWho, setShotWho] = useState(null);       // {email, name}
  const [shotFrames, setShotFrames] = useState(null);
  const [shotView, setShotView] = useState(null);     // open lightbox at this frame index
  useEffect(() => {
    if (view !== 'screenshots') return;
    setShotPeople(null); setShotWho(null); setShotFrames(null); setShotView(null);
    api.timeTeamShots(shotDate).then(r => setShotPeople(r.people || [])).catch(() => setShotPeople([]));
  }, [view, shotDate]);
  useEffect(() => {
    if (!shotWho) { setShotFrames(null); return; }
    setShotFrames(null); setShotView(null);
    api.timeTeamShots(shotDate, shotWho.email).then(r => setShotFrames(r.shots || [])).catch(() => setShotFrames([]));
  }, [shotWho, shotDate]);


  // Disclosed-monitoring tamper/coverage alerts - surfaces employees who are
  // clocked in while their agent has gone quiet (killed/uninstalled/offline), so
  // evasion is a visible, attributable event rather than a silent success. Polled.
  const [monAlerts, setMonAlerts] = useState([]);
  useEffect(() => {
    let live = true;
    const loadAlerts = () => api.timeMonitoringAlerts()
      .then(r => { if (live) setMonAlerts(Array.isArray(r?.alerts) ? r.alerts : []); })
      .catch(() => {});
    loadAlerts();
    const stop = pollWhileVisible(loadAlerts, 60000);
    return () => { live = false; stop(); };
  }, []);

  // Punch-fix requests (employee add/remove) awaiting this approver's decision.
  const [punchReqs, setPunchReqs] = useState([]);
  const loadPunchReqs = useCallback(() =>
    api.timePunchRequests('pending').then(r => setPunchReqs(Array.isArray(r) ? r : [])).catch(() => {}), []);
  useEffect(() => {
    loadPunchReqs();
    return pollWhileVisible(loadPunchReqs, 60000);
  }, [loadPunchReqs]);
  async function decidePunchReq(id, status) {
    let note = '';
    if (status === 'rejected') {
      const r = await dialog.prompt('', { title: 'Reject request', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (r === null) return;   // cancelled - do NOT reject
      note = r;
    }
    try {
      await api.timeDecidePunchRequest(id, { status, note });
      toastOk(`Request ${status}.`);
      loadPunchReqs();
      load(true);   // an approved add/remove changes the timecard - keep the rows in sync
    } catch (e) { toastErr(e?.message || 'Could not update the request.'); }
  }

  async function revokeApproval(id) {
    try { await api.timeApprovalRevoke(id); toastOk('Approval revoked.'); load(true); }
    catch (e) { toastErr(e?.message || 'Could not revoke.'); }
  }

  async function decideTimeoff(id, status) {
    let note = '';
    if (status === 'rejected') {
      note = await dialog.prompt('', { title: 'Reject time-off request', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (note === null) return;   // cancelled - do NOT reject (was the cancel-still-rejects bug)
    }
    try {
      await api.timeOffDecide(id, { status, note: note || '' });
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
      toastOk('Punch updated - the original time stays on record.');
      setEdit(null); load(true);
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
      setAddFor(null); setAddP({ kind: 'out', at: '', note: '' }); load(true);
    } catch (e) { toastErr(e?.message || 'Could not add the punch.'); }
    setBusy(false);
  }

  const totalMin = (rows || []).reduce((a, r) => a + r.workedMin, 0);
  const totalFlags = (rows || []).reduce((a, r) => a + r.flagCount, 0);
  const pendingCount = timeoff.filter(r => r.status === 'pending').length;
  const approvedCount = (rows || []).filter(isRowApproved).length;

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {/* KPI strip - Work OS kpi-cards (meaning-dot label + big tabular numeral) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[['Team hours', fmtMin(totalMin), 'card-blue'],
          ['Approved', `${approvedCount}/${(rows || []).length}`, approvedCount === (rows || []).length && rows?.length ? 'card-green' : ''],
          ['Punch flags', String(totalFlags), totalFlags ? 'card-orange' : ''],
          ['Time off pending', String(pendingCount), pendingCount ? 'card-orange' : '']].map(([label, value, cls]) => (
          <div key={label} className={`kpi-card ${cls}`} style={{ padding: '14px 18px' }}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value" style={{ fontSize: 22, margin: '4px 0 0' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Monitoring tamper/coverage alerts - clocked in but agent quiet. */}
      {monAlerts.length > 0 && (
        <div style={{ marginBottom: 16, border: '1px solid hsla(var(--color-red),0.4)', background: 'hsla(var(--color-red),0.06)', borderRadius: 12, padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <AlertTriangle size={15} style={{ color: 'hsl(var(--color-red))' }} />
            <span style={{ fontWeight: 800, fontSize: 13.5 }}>Monitoring Alerts</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {monAlerts.length} clocked in with a quiet agent
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {monAlerts.map(a => (
              <div key={a.email} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: a.severity === 'high' ? 'hsl(var(--color-red))' : '#b45309' }} />
                <strong>{a.name}</strong>
                <span style={{ fontWeight: 700, color: a.severity === 'high' ? 'hsl(var(--color-red))' : '#b45309' }}>{a.reason}</span>
                {a.detail && <span style={{ color: 'var(--muted)' }}>{a.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sub-screen nav - these are PAGES of a complex module, so they get the
          Documents-style underline tab band (icons, brand underline, hairline
          base) instead of floating pills that merged into the content. */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--wk-line)' }}>
        {[['payroll', 'Payroll', Banknote], ['attendance', 'Attendance', CalendarDays],
          ['insights', 'Insights', Activity], ['requests', 'Punch requests', Inbox, punchReqs.length],
          ['screenshots', 'Screenshots', Camera], ['shifts', 'Shifts', CalendarClock],
          ['timeoff', 'Time off', CalendarOff, pendingCount]].map(([key, label, Icon, badge]) => {
          const on = view === key;
          return (
            <button key={key} onClick={() => setView(key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', border: 'none', background: 'none',
                cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13.5, fontWeight: on ? 700 : 600,
                color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent',
                transition: 'color .12s, border-color .12s' }}>
              <Icon size={15} /> {label}
              {badge > 0 && (
                <span style={{ background: on ? 'var(--wk-brand)' : 'var(--wk-faint)', color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '1px 7px', lineHeight: 1.4 }}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Range + export bar (shared by Timecards and Insights) */}
      {view === 'insights' && (
      /* Insights date range only - approve/CSV live on the Payroll timecard now. */
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {[['This week', 0], ['Last week', -1]].map(([l, off]) => {
          const r = weekRange(off);
          const active = r[0] === start && r[1] === end;
          return (
            <button key={l} className="secondary-btn" onClick={() => setRange(r)}
              style={{ fontSize: 12, ...(active ? { background: 'var(--wk-brand)', color: '#fff', borderColor: 'var(--wk-brand)' } : {}) }}>{l}</button>
          );
        })}
        <input className="form-input" type="date" value={start} onChange={e => setRange([e.target.value, end])} style={{ fontSize: 12, width: 150 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
        <input className="form-input" type="date" value={end} onChange={e => setRange([start, e.target.value])} style={{ fontSize: 12, width: 150 }} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>Team total: <span style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtMin(totalMin)}</span></span>
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
        <div key={r.email} style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 14, marginBottom: 8, overflow: 'hidden', boxShadow: 'var(--wk-shadow)' }}>
          <div onClick={() => setOpen(o => ({ ...o, [r.email]: !o[r.email] }))} role="button"
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
            {open[r.email] ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
            <button onClick={e => { e.stopPropagation(); setPerson(r); }} title="Open their time profile"
              style={{ fontSize: 13, fontWeight: 700, flex: '0 0 200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, fontFamily: 'var(--wk-font)',
                color: 'var(--wk-brand)', textDecoration: 'underline', textDecorationColor: 'transparent', textUnderlineOffset: 3 }}
              onMouseEnter={e => { e.currentTarget.style.textDecorationColor = 'var(--wk-brand)'; }}
              onMouseLeave={e => { e.currentTarget.style.textDecorationColor = 'transparent'; }}>{r.name}</button>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
            {r.flagCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: '#b45309' }}>
                <AlertTriangle size={11} /> {r.flagCount}
              </span>
            )}
            {r.pendingEdits > 0 && (
              <button onClick={e => { e.stopPropagation(); setPayrollEmail(r.email); setView('payroll'); }}
                title={`${r.pendingEdits} time edit${r.pendingEdits === 1 ? '' : 's'} from this employee awaiting your review - click to open their Payroll timecard and approve or reject each`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', border: 'none', padding: '3px 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
                <Pencil size={10} /> {r.pendingEdits} to review
              </button>
            )}
            {r.breakMin > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.breakMin}m break</span>}
            {isRowApproved(r) ? (
              <span title="Every worked day in this period is signed off and unchanged since"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.1)', padding: '3px 9px', borderRadius: 999 }}>
                <CheckCircle size={11} /> Approved
                {r.approval && (
                  <button onClick={e => { e.stopPropagation(); revokeApproval(r.approval.id); }} title="Revoke approval"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex', padding: 0, marginLeft: 2 }}><X size={10} /></button>
                )}
              </span>
            ) : rowStale(r) ? (
              <button className="primary-btn" onClick={e => { e.stopPropagation(); approveDays(r.email, Object.keys(r.days || {})); }}
                title="Punches changed after sign-off - the approval is stale and needs redoing"
                style={{ fontSize: 11, padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 5, background: '#b45309' }}>
                <AlertTriangle size={11} /> Re-approve
              </button>
            ) : (
              <button className="primary-btn" onClick={e => { e.stopPropagation(); approveDays(r.email, Object.keys(r.days || {})); }}
                title="Sign off every worked day in the selected period"
                style={{ fontSize: 11, padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle size={11} /> Approve
              </button>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', width: 62, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMin(r.workedMin)}</span>
          </div>

          {open[r.email] && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '10px 14px 12px 38px' }}>
              {Object.keys(r.days).sort().map(date => {
                const d = r.days[date];
                return (
                  <div key={date} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800 }}>{new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtMin(d.workedMin)}{d.breakMin ? ` · ${d.breakMin}m break` : ''}</span>
                      {d.flags.map(f => <span key={f} style={{ fontSize: 11, fontWeight: 700, color: '#b45309' }}>{f.replace(/_/g, ' ')}</span>)}
                    </div>
                    <div style={{ margin: '5px 0 4px', maxWidth: 560 }}><DayTimeline punches={d.punches} height={18} date={date} /></div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {d.punches.map(p => (
                        <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '4px 10px', borderRadius: 10,
                          background: p.voided ? 'transparent' : p.geoStatus === 'out_of_fence' ? 'rgba(180,83,9,0.1)' : 'var(--mist)',
                          border: '1px solid var(--line)', color: p.voided ? 'var(--line)' : 'var(--ink)',
                          textDecoration: p.voided ? 'line-through' : 'none' }}>
                          <b>{KIND_LABEL[p.kind]}</b> {localTime(p.at)}
                          {p.originalAt && <span title={`Originally ${localTime(p.originalAt)} - adjusted by ${p.adjustedBy}`} style={{ color: '#b45309', fontWeight: 700 }}>✎</span>}
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

      {/* Attendance - month calendar with leave bars (TrackingTime overview) */}
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
                {new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
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
                <div key={d} style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', padding: '2px 6px' }}>{d}</div>
              ))}
              {cells.map((n, i) => {
                if (n === null) return <div key={`e${i}`} />;
                const ds = `${attMonth}-${String(n).padStart(2, '0')}`;
                const entries = onDay(n);
                return (
                  <div key={n} style={{ minHeight: 72, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 6px',
                    background: ds === today ? 'var(--wk-brand-tint)' : 'var(--card)' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: ds === today ? 'var(--wk-brand)' : 'var(--muted)' }}>{n}</div>
                    {entries.slice(0, 3).map(r => (
                      <div key={r.id} title={`${r.name || r.email} - ${r.type} ${r.startDate} → ${r.endDate}${r.status === 'pending' ? ' (pending)' : ''}`}
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

      {/* Insights - activity dashboard (Top Apps / Websites / productivity), then
          the hours breakdown from the punch data. */}
      {view === 'insights' && (
        <div style={{ marginBottom: 18 }}>
          <TimeInsights start={start} end={end} people={(rows || []).map(r => ({ email: r.email, name: r.name }))} />
        </div>
      )}
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
              <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: 16, boxShadow: 'var(--wk-shadow)' }}>
                <div style={{ ...HD, marginBottom: 12 }}>Hours by person</div>
                {sorted.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No hours in this range.</div>}
                {sorted.map(r => (
                  <div key={r.email} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700 }}>{r.name}</span>
                      <span style={{ fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtMin(r.workedMin)}</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--mist)', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ width: `${(r.workedMin / maxWork) * 100}%`, height: '100%', background: 'var(--wk-brand)', borderRadius: 99 }} />
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: 16, boxShadow: 'var(--wk-shadow)' }}>
                <div style={{ ...HD, marginBottom: 12 }}>Daily team hours</div>
                {dates.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No hours in this range.</div>}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140 }}>
                  {dates.map(d => (
                    <div key={d} title={`${d} - ${fmtMin(dayTotals[d])}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                      <div style={{ width: '70%', maxWidth: 38, height: `${Math.max(5, (dayTotals[d] / maxDay) * 110)}px`, background: 'var(--wk-brand)', borderRadius: 99 }} />
                      <span style={{ fontSize: 9.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })())}

      {/* Shifts - weekly schedule grid + preset/group manager */}
      {view === 'shifts' && (
        <>
          <div className="chip-row" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {[['schedule', 'Schedule'], ['presets', 'Presets & groups']].map(([key, label]) => (
              <button key={key} onClick={() => setShiftMode(key)}
                style={{ padding: '5px 13px', borderRadius: 999, border: `1px solid ${shiftMode === key ? 'transparent' : 'var(--wk-line2)'}`,
                  background: shiftMode === key ? 'var(--wk-brand-tint)' : 'var(--card)',
                  color: shiftMode === key ? 'var(--wk-brand)' : 'var(--muted)',
                  fontWeight: shiftMode === key ? 700 : 600, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
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

      {/* Payroll - per-employee, per-pay-period editable timecard */}
      {view === 'payroll' && <PayrollTimecard toastOk={toastOk} toastErr={toastErr} initialEmail={payrollEmail} />}


      {/* Punch-fix requests - employee asked to add/remove a punch; approve applies it. */}
      {view === 'requests' && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
          {punchReqs.length === 0 ? (
            <div style={{ padding: '24px 18px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
              No punch-fix requests waiting. When someone asks to add or remove a punch, it shows here for you to approve or reject.
            </div>
          ) : punchReqs.slice(0, 500).map(r => {
            const kindLabel = { in: 'clock-in', out: 'clock-out', break_start: 'break start', break_end: 'break end' }[r.punchKind] || r.punchKind;
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>{r.employeeName || r.employeeEmail}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 2 }}>
                    {r.action === 'add'
                      ? `Add a ${kindLabel} punch${r.at ? ` at ${new Date(r.at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}`
                      : 'Remove a punch'}
                  </div>
                  {r.reason && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>“{r.reason}”</div>}
                </div>
                <button className="secondary-btn" onClick={() => decidePunchReq(r.id, 'rejected')}
                  style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>Reject</button>
                <button className="primary-btn" onClick={() => decidePunchReq(r.id, 'approved')}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <CheckCircle size={13} /> Approve
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Time-off register - requests table, pending rows carry the decisions */}
      {view === 'timeoff' && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--wk-shadow)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, padding: '10px 14px', background: 'var(--wk-hover)', fontSize: 12.5, fontWeight: 500, color: 'var(--wk-dim)' }}>
            <span>Requested by</span><span>Type</span><span>Period</span><span>Days</span><span>Approver</span><span style={{ textAlign: 'right' }}>Status</span>
          </div>
          {timeoffErr ? (
            <div style={{ padding: '14px 16px' }}><ErrorBanner message="Couldn't load time-off requests right now." onRetry={loadTimeoff} /></div>
          ) : timeoff.length === 0 && (
            <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>No time-off requests yet.</div>
          )}
          {timeoff.slice(0, 150).map(r => {
            const days = Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1;
            return (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: r.status === 'pending' ? 'rgba(251,191,36,0.05)' : 'transparent' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.email}</span>
                <span style={{ fontSize: 12, textTransform: 'capitalize' }}>{r.type}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }} title={r.note}>{r.startDate} → {r.endDate}{r.note ? ' · “' + r.note + '”' : ''}</span>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{isNaN(days) ? '-' : days}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.approver || '-'}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  {r.status === 'pending' ? (<>
                    <button className="secondary-btn" onClick={() => decideTimeoff(r.id, 'rejected')} style={{ fontSize: 11, color: '#b91c1c', padding: '4px 10px' }}>Reject</button>
                    <button className="primary-btn" onClick={() => decideTimeoff(r.id, 'approved')} style={{ fontSize: 11, padding: '4px 10px' }}>Approve</button>
                  </>) : (
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', padding: '2px 10px', borderRadius: 999,
                      background: r.status === 'approved' ? 'hsla(var(--color-green),0.1)' : r.status === 'rejected' ? 'rgba(185,28,28,0.08)' : 'var(--mist)',
                      color: r.status === 'approved' ? 'hsl(var(--color-green))' : r.status === 'rejected' ? '#b91c1c' : 'var(--muted)' }}>
                      {r.status}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {timeoff.length > 150 && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Showing 150 of {timeoff.length} - filter to narrow down.</div>}
        </div>
      )}

      {/* Screenshots - disclosed-monitoring, manager-scoped team gallery.
          Pick a day → team members with captures → their frame grid (signed URLs). */}
      {view === 'screenshots' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {shotWho && (
              <button className="secondary-btn" onClick={() => setShotWho(null)}
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}>
                <ChevronLeft size={13} /> Back
              </button>
            )}
            <span className="wkc-chip"><Camera size={14} /></span>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Screenshots{shotWho ? ` - ${shotWho.name}` : ''}</span>
            <div style={{ flex: 1 }} />
            <input className="form-input" type="date" value={shotDate} onChange={e => setShotDate(e.target.value)}
              style={{ fontSize: 12, width: 150 }} />
          </div>

          {!shotWho && (
            shotPeople === null
              ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
              : shotPeople.length === 0
                ? <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12 }}>
                    No captures on this day. Frames are saved while a team member is clocked in with screen capture on.
                  </div>
                : <div style={{ display: 'grid', gap: 8 }}>
                    {shotPeople.map(p => (
                      <button key={p.email} onClick={() => setShotWho(p)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                          border: '1px solid var(--wk-line2)', background: 'var(--card)', fontFamily: 'var(--wk-font)' }}>
                        <Camera size={15} style={{ color: 'var(--wk-brand)' }} />
                        <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>{p.name}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{p.count} frame{p.count === 1 ? '' : 's'}</span>
                      </button>
                    ))}
                  </div>
          )}

          {shotWho && (
            shotFrames === null
              ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
              : shotFrames.length === 0
                ? <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>No frames for this person on this day.</div>
                : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                    {shotFrames.map((s, i) => (
                      <button key={s.id} onClick={() => setShotView(i)} title="Click to view - use arrow keys to browse"
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--mist)', cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
                        <img src={s.url} alt={`Capture ${localTime(s.at)}`} loading="lazy"
                          style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
                          <span style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--ink)' }}>{localTime(s.at)}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.activeView}</span>
                          {s.idleSec >= 300 && (
                            <span title={`No input for ${Math.round(s.idleSec / 60)} min at capture`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 800, color: '#b45309' }}>
                              <MoonStar size={10} /> idle {Math.round(s.idleSec / 60)}m
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
          )}
          <ImageLightbox shots={shotFrames} index={shotView} setIndex={setShotView} />
        </div>
      )}

      {/* Person time portal - everything time-related for one employee.
          Portaled to <body>: host cards (Manager Dashboard) have transformed
          ancestors that would otherwise trap position:fixed overlays. */}
      {person && createPortal((() => {
        const p = (rows || []).find(r => r.email === person.email) || person;
        const myOff = timeoff.filter(t => t.email === p.email);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => e.target === e.currentTarget && setPerson(null)}>
            <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 780, maxHeight: 'min(92dvh, 720px)', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--wk-brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                  {p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email} · {start} → {end}</div>
                </div>
                {(() => {
                  const dk = Object.keys(p.days || {});
                  if (isRowApproved(p)) {
                    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.1)', padding: '4px 11px', borderRadius: 999 }}><CheckCircle size={12} /> Approved</span>;
                  }
                  if (rowStale(p)) {
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: '#b45309', background: 'rgba(180,83,9,0.1)', padding: '4px 11px', borderRadius: 999 }}><AlertTriangle size={12} /> Changed since approval</span>
                        <button className="primary-btn" onClick={() => approveDays(p.email, dk)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, background: '#b45309' }}><CheckCircle size={12} /> Re-approve week</button>
                      </span>
                    );
                  }
                  const done = dk.filter(d => (p.dayApprovals || {})[d] && !(p.dayApprovals || {})[d].stale).length;
                  return (
                    <button className="primary-btn" onClick={() => approveDays(p.email, dk)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <CheckCircle size={12} /> Approve week{done > 0 ? ` (${dk.length - done} left)` : ''}
                    </button>
                  );
                })()}
                <button onClick={() => setPerson(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 16 }}>
                  {[['Worked', fmtMin(p.workedMin), 'var(--ink)'],
                    ['Breaks', `${p.breakMin}m`, 'var(--ink)'],
                    ['Days', String(Object.keys(p.days || {}).length), 'var(--ink)'],
                    ['Flags', String(p.flagCount), p.flagCount ? '#b45309' : 'var(--muted)']].map(([l, v, c]) => (
                    <div key={l} style={{ background: 'var(--mist)', borderRadius: 10, padding: '10px 14px' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{l}</div>
                      <div style={{ fontSize: 17, fontWeight: 700, color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                    </div>
                  ))}
                </div>

                {Object.keys(p.days || {}).length > 1 && (() => {
                  const dts = Object.keys(p.days).sort();
                  const mx = Math.max(1, ...dts.map(d => p.days[d].workedMin));
                  return (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ ...HD, marginBottom: 8 }}>Daily hours</div>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 90 }}>
                        {dts.map(d => (
                          <div key={d} title={`${d} - ${fmtMin(p.days[d].workedMin)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
                            <div style={{ width: '65%', maxWidth: 34, height: `${Math.max(5, (p.days[d].workedMin / mx) * 66)}px`, background: 'var(--wk-brand)', borderRadius: 99 }} />
                            <span style={{ fontSize: 9, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div style={{ ...HD, marginBottom: 8 }}>
                  Days <span style={{ fontWeight: 500, color: 'var(--muted)' }}>- click one for its punches</span>
                </div>
                {Object.keys(p.days || {}).sort().map(date => (
                  <AdminDayRow key={date} date={date} email={p.email} d={p.days[date]}
                    approval={(p.dayApprovals || {})[date]}
                    onApprove={() => approveDays(p.email, [date])} />
                ))}
                {Object.keys(p.days || {}).length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No punches in this range.</div>}

                <div style={{ ...HD, margin: '18px 0 8px' }}>Time off</div>
                {myOff.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No requests on record.</div>}
                {myOff.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, textTransform: 'capitalize', width: 80 }}>{t.type}</span>
                    <span style={{ color: 'var(--muted)', flex: 1 }}>{t.startDate} → {t.endDate}{t.note ? ` · “${t.note}”` : ''}</span>
                    <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'capitalize', padding: '2px 10px', borderRadius: 999,
                      background: t.status === 'approved' ? 'hsla(var(--color-green),0.1)' : t.status === 'rejected' ? 'rgba(185,28,28,0.08)' : 'rgba(180,83,9,0.1)',
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
              <span className="wkc-chip"><Clock size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Adjust punch - {KIND_LABEL[edit.kind]}</h3>
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
              <span className="wkc-chip"><Plus size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add punch - {addFor}</h3>
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
