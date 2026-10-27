import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock, ChevronDown, ChevronRight, MapPin, AlertTriangle, Download,
  Pencil, Plus, X, CheckCircle, Ban,
  Activity, Inbox, Banknote, CalendarOff,
  Search, Lock, Receipt,
} from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import DayTimeline from './DayTimeline';
import PayrollTimecard from './PayrollTimecard';
import RetroPayReport from './RetroPayReport';
import AddTimeModal from './AddTimeModal';
import TimeInsights from './TimeInsights';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { MonitoringAlertsLine } from './MonitoringAlerts';
import { ErrorBanner, Spinner } from './AsyncState';
import { formatDate, formatPacificDateTime, zonedDateTime, zonedInputValue, zonedInputToUtc, zoneOffsetMin } from '../lib/datetime';
import { leaveRequestDays, fmtDays } from '../lib/workdayStats';
import { TIMEOFF_FILTERS, countByStatus, filterAndSortTimeoff, nextSort, yearsOf, inPeriod } from '../lib/timeOffFilter';
import { takePendingOpen } from '../lib/pendingOpen';
import TimesheetsToReview from './TimesheetsToReview';
import { Avatar } from '../tasks/components';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import { formatDistance, formatAccuracy } from '../lib/distance';
import { useRole } from '../contexts/RoleContext';
import PayrollReadiness from './PayrollReadiness';
import { ForChip, ApprovalDelegationsAdmin } from './DelegateApprovals';
import TeamLeaveCalendar from './TeamLeaveCalendar';
import LeaveBalancesAdmin from './LeaveBalances';
import { LeaveYearEndPreview } from './LeaveYearEnd';
import LeaveHistory from './LeaveHistory';
import CaReview from './CaReview';
import LongShiftWarning from './LongShiftWarning';
import { checkLongShift } from '../lib/longShift';
import ContractorInvoices from './ContractorInvoices';

// Launch (Neil, 10/16): timecards are approved by Agree in the timesheet
// review and signed in Nexus Sign, so the per-day / per-period Approve
// buttons (POST /timeclock/approvals) are hidden. Flip to true to show them.
const LEGACY_APPROVE = false;

// Confidential time off (Sep 29): the server blanks the note for anyone but
// the requester and approver ("redacted"); the type still shows (Neil, Sep
// 30: "Time off - Medical", never the detail).
const timeoffLabel = (r) => r.type || 'Time off';
function ConfidentialMark() {
  return (
    <span title="Confidential - the note is visible only to the employee and their approver"
      aria-label="Confidential" style={{ display: 'inline-flex', color: 'var(--muted)', flexShrink: 0 }}>
      <Lock size={11} />
    </span>
  );
}

// ── HR → Time: team timesheets, corrections, payroll export ──────────────────
// Single-screen review (the SwipeClock manager expectation): every employee's
// totals for the range, expandable to day → punch level with geofence status
// and a map pin per located punch. Corrections freeze the original time and
// stamp who adjusted; voids hide from totals but stay in the record.

const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break start', break_end: 'Break end' };
// A punch on the EMPLOYEE's clock (`tz` = the team row's timeZone), labeled
// "8:30 AM PT" only when the viewer's clock reads differently (Oct 20).
const localTime = (iso, tz) => (iso && zonedDateTime(iso, tz)?.label) || '-';
// The employee's zone label when it is not the viewer's ('' otherwise).
const zoneTag = (tz) => { const z = zonedDateTime(new Date(), tz); return z?.differs ? z.zone : ''; };
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
// The viewer's LOCAL calendar date - toISOString is UTC, which after 5 PM
// Pacific made "This week" run Tuesday to Monday (Oct 16).
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// One day inside the person drawer - click to reveal the working/idle
// breakdown and the desktop agent's app/window log for that day.
function AdminDayRow({ date, email, d, approval, onApprove, timeZone }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontFamily: 'var(--wk-font)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, width: 92, flexShrink: 0, color: 'var(--ink)' }}>{new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <DayTimeline punches={d.punches} height={18} date={date} />
        {d.flags.length > 0 && <AlertTriangle size={12} style={{ color: '#b45309', flexShrink: 0 }} />}
        {onApprove && LEGACY_APPROVE && (
          approval && !approval.stale ? (
            <span title={`Approved by ${approval.by} · ${formatPacificDateTime(approval.at, '-')}`}
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
              {' '}{localTime(p.at, timeZone)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
// The Adjust input shows the punch on the EMPLOYEE's clock; saveEdit turns
// what was typed back into UTC on that same clock (Oct 20).
const utcToInput = (iso, tz) => zonedInputValue(iso, tz);

function readTimeoffFilter(key) {
  try {
    const v = localStorage.getItem(key);
    return TIMEOFF_FILTERS.some(([f]) => f === v) ? v : 'pending';
  } catch { return 'pending'; }
}

function weekRange(offset = 0) {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [isoDate(mon), isoDate(sun)];
}

// One punch fix = one person + one punch kind + one minute. An employee who
// files the same fix twice made one request (the server closes the copies).
const punchReqKey = (r) => (r.action === 'add' && r.at)
  ? `${(r.employeeEmail || '').toLowerCase()}|${r.punchKind}|${r.at.slice(0, 16)}`
  : r.id;

// Form label + card-header title (Work OS grammar - sentence case, no tracking).
const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };

// hrPanels: People > Time shows HR's leave panels under Time Off (balances,
// year end, approval stand-ins, the old Leave history) - they moved here when
// the People > Leave tab was retired (Oct 27 2026). The dashboard card does not.
export default function TimeAdmin({ toastOk, toastErr, initialView, hrPanels = false }) {
  // The manager tier sees its team's hours, never pay (Oct 6).
  const { hrTeam, myEmail } = useRole() || {};
  // Your own time is approved and fixed by your manager or HR, never here (Oct 20, _refuse_own_time).
  const isMe = (em) => !!em && !!myEmail && em.toLowerCase() === myEmail.toLowerCase();
  // payroll (the timecard) | actions (punch requests + missing punches) | timeoff | hours.
  // Attendance, Screenshots and By Location left People (Neil, 10/06): who is
  // on lives in Shifts > Schedule, screenshots and location hours in Workforce
  // Analytics.
  const [view, setView] = useState(initialView || 'payroll');
  // Live map tab removed Aug 4 - superseded by the top-level Locations map.
  // A specific employee + period to open (Sep 29): Timesheets to Review, the
  // "Timesheet to review" bell, and the Daily Briefing / Weekly Digest link.
  // The key remounts the timecard so it starts on that period. Read once on
  // mount - from an email link's ?timecard=<email>&start=<date>&type=<pay type>,
  // else a bell click left for this screen while it was still loading.
  const [firstTarget] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('timecard')) return { email: q.get('timecard'), start: q.get('start') || '', payType: q.get('type') || '' };
    return takePendingOpen('timecard');
  });
  const [payrollEmail, setPayrollEmail] = useState(firstTarget?.email || '');   // preselect a person in the Payroll view (from the "to review" badge)
  const [payrollTarget, setPayrollTarget] = useState({ start: firstTarget?.start || '', payType: firstTarget?.payType || '', key: 0 });
  const openTimecard = useCallback((email, start, payType) => {
    if (!email) return;
    setPayrollEmail(email);
    setPayrollTarget(t => ({ start: start || '', payType: payType || '', key: t.key + 1 }));
    setView('payroll');
  }, []);
  // The punch-fix request a notice named: the list opens on it (see the
  // Punch requests view). Read once on mount for a bell click made while this
  // screen was still loading, then live through nexus:open-punch-request.
  const [focusReq, setFocusReq] = useState(() => takePendingOpen('punchRequest') || '');
  const focusPunchRequest = useCallback((id) => {
    if (!id) return;
    setFocusReq(id);
    setView('actions');
  }, []);
  useEffect(() => {
    if (!focusReq || view !== 'actions') return undefined;
    // A copy of a duplicated fix has no row of its own - it lives on its twin's.
    const t = setTimeout(() => (document.getElementById(`punch-req-${focusReq}`)
      || [...document.querySelectorAll('[data-req-ids]')].find(el => el.dataset.reqIds.split(' ').includes(focusReq)))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => clearTimeout(t);
  }, [focusReq, view]);
  useEffect(() => {
    // Drop the link's parameters once used, so a reload doesn't reopen it.
    const q = new URLSearchParams(window.location.search);
    if (q.get('timecard')) {
      ['timecard', 'start', 'type'].forEach(k => q.delete(k));
      const rest = q.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }
    // A bell click while this screen is already open.
    const onOpen = (e) => { takePendingOpen('timecard'); openTimecard(e.detail?.email, e.detail?.start, e.detail?.payType); };
    window.addEventListener('nexus:open-timecard', onOpen);
    // "Timesheet fix requested" names its request (Neil, 10/02: the notice
    // "doesn't take me to Amy's approval"): the Punch requests list, that row
    // highlighted and scrolled to.
    const onOpenReq = (e) => { takePendingOpen('punchRequest'); focusPunchRequest(e.detail?.id); };
    window.addEventListener('nexus:open-punch-request', onOpenReq);
    return () => { window.removeEventListener('nexus:open-timecard', onOpen); window.removeEventListener('nexus:open-punch-request', onOpenReq); };
  }, [openTimecard, focusPunchRequest]);
  // Contractor invoices waiting on HR (Oct 21) - the Invoices tab badge. HR only, never the manager tier.
  const [invoiceDrafts, setInvoiceDrafts] = useState(0);
  const loadInvoiceDrafts = useCallback(() => {
    if (hrTeam) return;
    Promise.resolve().then(() => api.contractorInvoices('draft')).then(r => setInvoiceDrafts((r?.invoices || []).length)).catch(() => {});
  }, [hrTeam]);
  useEffect(() => { loadInvoiceDrafts(); }, [loadInvoiceDrafts]);
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
    api.timeTeam(start, end).then(r => setRows(r.rows)).catch(e => { setRows([]); toastErr(e?.message || 'Could not load time sheets.'); });
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
    // Plus the requests waiting for me as HR (Second Approval By HR, Oct 27
    // 2026) - an HR contact may not see them in the team list.
    Promise.all([api.timeOffList(), api.timeOffAwaitingHr().catch(() => [])])
      .then(([r, hr]) => {
        const seen = new Set((r || []).map(x => x.id));
        setTimeoff([...(hr || []).filter(x => !seen.has(x.id)), ...(r || [])]);
      })
      .catch(() => setTimeoffErr(true));   // don't mask a failure as "no requests"
  }, []);
  useEffect(() => { loadTimeoff(); }, [loadTimeoff]);


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
    let ok = 0, blocked = 0;
    for (const r of targets) { // sequential - one bell per person, no request race
      try { await api.timeApprove({ email: r.email, days: Object.keys(r.days) }); ok++; }
      // A row with an unresolved missing/unmatched punch is held, not approved -
      // say so rather than silently dropping it from the count.
      catch (e) { if (e?.detail?.code === 'unresolved_exceptions') blocked++; }
    }
    toastOk(`Approved ${ok} of ${targets.length} time sheet${targets.length === 1 ? '' : 's'}`
      + (blocked ? ` - ${blocked} held for missing punches` : '') + '.');
    setApprovingAll(false);
    load(true);
  }
  const [person, setPerson] = useState(null);   // employee drill-down (their time portal)

  // Punch-fix requests (employee add/remove) awaiting this approver's decision.
  const [punchReqs, setPunchReqs] = useState([]);
  const [reqSearch, setReqSearch] = useState('');
  const [actDept, setActDept] = useState('');      // Action Log: one department, '' = all
  const [actKind, setActKind] = useState('all');   // all | requests | missing
  const [selReqs, setSelReqs] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const loadPunchReqs = useCallback(() =>
    api.timePunchRequests('pending').then(r => setPunchReqs(Array.isArray(r) ? r : [])).catch(() => {}), []);
  useEffect(() => {
    loadPunchReqs();
    return pollWhileVisible(loadPunchReqs, 60000);
  }, [loadPunchReqs]);
  // The Type an approver picked for a requested clock-in ({id: 'Sick'}) - sent on approve.
  const [reqType, setReqType] = useState({});
  // Bulk approve / reject of the selected requests (one note for all rejects).
  async function decideMany(ids, status) {
    if (!ids.length) return;
    // Copies of the same fix (same person, punch and minute) are one fix: send
    // only the first - the server closes the copies with it (Charmi, Oct 7).
    const byKey = new Map(punchReqs.map(r => [r.id, punchReqKey(r)]));
    const seenKeys = new Set();
    ids = ids.filter(id => { const k = byKey.get(id) || id; if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
    let note = '';
    if (status === 'rejected') {
      const r = await dialog.prompt('', { title: `Reject ${ids.length} request${ids.length === 1 ? '' : 's'}`, message: 'Sent to each employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (r === null) return;
      note = r;
    }
    setBulkBusy(true);
    // Off the list at once; this run still reads the list it started with.
    dropPunchReqs(ids);
    let ok = 0, dupes = 0; const fails = [];
    // Apply in punch order (oldest first, clock-in before clock-out) so a
    // selected pair never hits the sequence guard because its later half
    // happened to be approved first.
    const kindRank = { in: 0, break_start: 1, break_end: 2, out: 3 };
    const byId = new Map(punchReqs.map(r => [r.id, r]));
    const ordered = [...ids].sort((x, y) => {
      const a = byId.get(x) || {}, b = byId.get(y) || {};
      return (a.at || '').localeCompare(b.at || '') || ((kindRank[a.punchKind] ?? 9) - (kindRank[b.punchKind] ?? 9));
    });
    for (const id of ordered) {
      const r = byId.get(id);
      if (r && r.status && r.status !== 'pending') { ok += 1; continue; }   // partner already applied by an earlier approval
      try {
        const res = await api.timeDecidePunchRequest(id, { status, note, ...(status === 'approved' && reqType[id] ? { category: reqType[id] } : {}) });
        if (res && res.status && res.status !== status) dupes += 1;   // already on the timecard - closed as a duplicate
        else ok += 1;
      } catch (e) {
        if (/already approved/i.test(e?.message || '')) { ok += 1; continue; }
        fails.push(e?.message || 'failed');
      }
    }
    setBulkBusy(false);
    setSelReqs(new Set());
    if (ok || dupes) toastOk([ok ? `${ok} request${ok === 1 ? '' : 's'} ${status}.` : '', dupes ? `${dupes} already on the time sheet - closed as duplicate${dupes === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' '));
    if (fails.length) toastErr(`${fails.length} could not be ${status}: ${fails[0]}`);
    loadPunchReqs();
  }

  async function decidePunchReq(id, status) {
    let note = '';
    if (status === 'rejected') {
      const r = await dialog.prompt('', { title: 'Reject request', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (r === null) return;   // cancelled - do NOT reject
      note = r;
    }
    // The row leaves the list the moment the decision is made (Visesh, Oct 19:
    // it sat there 4-5 seconds - the save, then a full list reload). The save
    // and the refresh run behind it; a failure brings the row back.
    dropPunchReqs([id]);
    try {
      const res = await api.timeDecidePunchRequest(id, { status, note, ...(status === 'approved' && reqType[id] ? { category: reqType[id] } : {}) });
      if (res && res.status && res.status !== status) toastOk('That punch is already on the time sheet - closed as a duplicate.');
      // Approving can also set aside a punch the fix replaces - say which (Oct 7).
      else toastOk(status === 'approved' && /Replaced|Also added/.test(res?.decisionNote || '') ? `Approved. ${res.decisionNote}` : `Request ${status}.`);
      load(true);   // an approved add/remove changes the timecard - keep the rows in sync
    } catch (e) { toastErr(e?.message || 'Could not update the request.'); }
    loadPunchReqs();
  }

  // Take decided requests off the list right away - and their copies (the same
  // fix asked twice), which the server closes with them.
  function dropPunchReqs(ids) {
    setPunchReqs(prev => {
      const keys = new Set(prev.filter(r => ids.includes(r.id)).map(punchReqKey));
      return prev.filter(r => !ids.includes(r.id) && !keys.has(punchReqKey(r)));
    });
  }

  async function revokeApproval(id) {
    try { await api.timeApprovalRevoke(id); toastOk('Approval revoked.'); load(true); }
    catch (e) { toastErr(e?.message || 'Could not revoke.'); }
  }

  // Punch exceptions for the range (SwipeClock "Show Missing Only") - the missing
  // and unmatched punches that block sign-off until fixed. Reloads with the range
  // and whenever a punch changes anywhere.
  const [exceptions, setExceptions] = useState(null);
  // A read-only viewer (the list needs team write) gets an error; the header
  // tile that showed it is gone (Sep 30), the Missing punches tab badge remains.
  const [, setExceptionsErr] = useState(false);
  const [addTimeFor, setAddTimeFor] = useState(null);   // { email, name, dates } - Add Time (Oct 14)
  const loadExceptions = useCallback(() => {
    api.timeExceptions(start, end).then(r => { setExceptions(Array.isArray(r) ? r : []); setExceptionsErr(false); })
      .catch(() => { setExceptions([]); setExceptionsErr(true); });
  }, [start, end]);
  useEffect(() => { loadExceptions(); }, [loadExceptions]);
  useEffect(() => {
    const onChange = () => loadExceptions();
    window.addEventListener('nexus:timeclock-changed', onChange);
    return () => window.removeEventListener('nexus:timeclock-changed', onChange);
  }, [loadExceptions]);
  const exBlocking = (exceptions || []).reduce((a, r) => a + (r.blocking || 0), 0);

  // Manager+ files a time-off request FOR an employee (Neil, Aug 11) - the
  // sanctioned path, so nobody needs Act As (Global Admin only) for this.
  const [obo, setObo] = useState(null);   // {email, type, start, end, note} | null
  // Admin-added time-off reasons (Sep 29), loaded when the form opens.
  const [oboReasons, setOboReasons] = useState([]);
  const oboOpen = !!obo;
  useEffect(() => {
    if (!oboOpen) return;
    api.timeOffTypes().then(r => setOboReasons(r.custom || [])).catch(() => {});
  }, [oboOpen]);
  const [oboBusy, setOboBusy] = useState(false);
  async function saveObo() {
    if (oboBusy) return;
    if (!obo.email) { toastErr('Pick the employee.'); return; }
    if (!obo.start || !obo.end) { toastErr('Pick the start and end dates.'); return; }
    setOboBusy(true);
    try {
      await api.timeOffOnBehalf({ employee_email: obo.email, type: obo.type,
        start_date: obo.start, end_date: obo.end, note: obo.note, confidential: !!obo.confidential });
      toastOk('Request filed - the employee has been notified.');
      setObo(null);
      loadTimeoff();
    } catch (e) { toastErr(e?.message || 'Could not file the request.'); }
    setOboBusy(false);
  }

  async function decideTimeoff(id, status) {
    let note = '';
    if (status === 'rejected') {
      note = await dialog.prompt('', { title: 'Reject time-off request', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (note === null) return;   // cancelled - do NOT reject (was the cancel-still-rejects bug)
    }
    try {
      const row = timeoff.find(r => r.id === id);
      const out = row?.awaitingHr
        ? await api.timeOffHrDecide(id, { status, note: note || '' })
        : await api.timeOffDecide(id, { status, note: note || '' });
      toastOk(out?.awaitingHr ? 'Approved - it now waits for HR approval.' : `Request ${status}.`);
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

  // AM / PM guard (Charmi, Oct 21): the person's other punches in this range,
  // on their clock, to judge a typed time against (lib/longShift.js).
  const [longWarn, setLongWarn] = useState(null);   // { form: 'edit' | 'add', issue }
  useEffect(() => { setLongWarn(null); }, [edit?.id, addFor, addP.kind]);
  const othersOf = (email, skipId) => {
    const r = (rows || []).find(x => x.email === email);
    if (!r) return [];
    return Object.values(r.days || {}).flatMap(d => d.punches || [])
      .filter(p => !p.voided && p.id !== skipId)
      .map(p => ({ kind: p.kind, at: utcToInput(p.at, r.timeZone) }));
  };

  async function saveEdit(opts) {
    if (busy) return;
    if (opts?.confirmLong !== true && edit.atInput && !edit.voided) {
      const issue = checkLongShift(othersOf(edit.email, edit.id), edit.kind, edit.atInput);
      if (issue) { setLongWarn({ form: 'edit', issue }); return; }
    }
    setLongWarn(null);
    setBusy(true);
    try {
      await api.timeAdjustPunch(edit.id, {
        at: edit.atInput ? zonedInputToUtc(edit.atInput, edit.timeZone) || undefined : undefined,
        note: edit.note, void: edit.voided, adjust_note: edit.adjustNote || '',
      });
      toastOk('Punch updated - the original time stays on record.');
      setEdit(null); load(true);
    } catch (e) { toastErr(e?.message || 'Could not update the punch.'); }
    setBusy(false);
  }

  async function saveAdd(opts) {
    if (busy) return;
    if (!addP.at) { toastErr('Pick the punch time.'); return; }
    if (opts?.confirmLong !== true) {
      const issue = checkLongShift(othersOf(addFor, ''), addP.kind, addP.at);
      if (issue) { setLongWarn({ form: 'add', issue }); return; }
    }
    setLongWarn(null);
    setBusy(true);
    try {
      // Typed on the employee's clock; the offset is their zone's on that
      // date (DST-correct), so the punch lands on their local day (Oct 20).
      const tz = (rows || []).find(x => x.email === addFor)?.timeZone;
      const at = zonedInputToUtc(addP.at, tz);
      await api.timeAddPunch({ employee_email: addFor, kind: addP.kind,
        at, tz_offset_min: zoneOffsetMin(tz, at), note: addP.note });
      toastOk('Punch added.');
      setAddFor(null); setAddP({ kind: 'out', at: '', note: '' }); load(true);
    } catch (e) { toastErr(e?.message || 'Could not add the punch.'); }
    setBusy(false);
  }

  const totalMin = (rows || []).reduce((a, r) => a + r.workedMin, 0);
  const pendingCount = timeoff.filter(r => r.status === 'pending').length;
  const decidableCount = timeoff.filter(r => r.status === 'pending' && r.canDecide !== false).length;
  // Time Off status chips (Charmi, Oct 20): opens on Pending - the requests
  // that still need a decision - and remembers each viewer's last chip.
  const timeoffFilterKey = `nexus.timeadmin.timeoffFilter.${(myEmail || '').toLowerCase()}`;
  const [timeoffFilter, setTimeoffFilterState] = useState(() => readTimeoffFilter(timeoffFilterKey));
  useEffect(() => { setTimeoffFilterState(readTimeoffFilter(timeoffFilterKey)); }, [timeoffFilterKey]);
  const setTimeoffFilter = (f) => {
    setTimeoffFilterState(f);
    try { localStorage.setItem(timeoffFilterKey, f); } catch { /* private window */ }
  };
  const [timeoffSort, setTimeoffSort] = useState(null);   // null = server order (newest first)
  const [timeoffYear, setTimeoffYear] = useState('');     // '' = all years (Neil, Oct 21)
  const [timeoffMonth, setTimeoffMonth] = useState('');   // '01'..'12', '' = all months
  const rangeText = `${formatDate(start)} - ${formatDate(end)}`;

  // Unsaved-changes guards for the edit/on-behalf/add-punch modals: an
  // overlay click, X, or Escape used to silently discard an in-progress
  // edit. Baseline is captured the render after each modal opens (the ref
  // starts null so the very first render right after open reads as clean).
  const editBaselineRef = useRef(null);
  useEffect(() => { editBaselineRef.current = edit || null; }, [!!edit]);
  const editDirty = !!edit && editBaselineRef.current !== null && JSON.stringify(edit) !== JSON.stringify(editBaselineRef.current);
  const editGuard = useUnsavedGuard(editDirty, () => setEdit(null), saveEdit);

  const oboBaselineRef = useRef(null);
  useEffect(() => { oboBaselineRef.current = obo || null; }, [!!obo]);
  const oboDirty = !!obo && oboBaselineRef.current !== null && JSON.stringify(obo) !== JSON.stringify(oboBaselineRef.current);
  const oboGuard = useUnsavedGuard(oboDirty, () => setObo(null), saveObo);

  const addBaselineRef = useRef(null);
  useEffect(() => { addBaselineRef.current = addFor ? addP : null; }, [!!addFor]);
  const addDirty = !!addFor && addBaselineRef.current !== null && JSON.stringify(addP) !== JSON.stringify(addBaselineRef.current);
  const addGuard = useUnsavedGuard(addDirty, () => setAddFor(null), saveAdd);

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {/* No summary tiles on top (Neil, Oct 20: "unnecessary clutter, the
          information is already there") - the Team Hours and Time Sheets to
          Review tiles went; the list below carries its own count. */}
      {/* Timesheets submitted to me and not decided yet (Sep 29). */}
      <TimesheetsToReview toastOk={toastOk} toastErr={toastErr}
        onOpen={(r) => openTimecard(r.employeeEmail, r.periodStart, r.payType)} />

      {/* Monitoring alerts live on Workforce Analytics now (Charmi, Sep 25: the
          block listing every person took half this screen). One line stays
          here: how many, and the way to the list. */}
      <MonitoringAlertsLine />

      {/* Sub-screen nav - these are PAGES of a complex module, so they get the
          Documents-style underline tab band (icons, brand underline, hairline
          base) instead of floating pills that merged into the content. */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 2, marginBottom: 18, borderBottom: '1px solid var(--wk-line)' }}>
        {[['payroll', 'Payroll', Banknote],
          ['actions', 'Action Log', Inbox, new Set(punchReqs.map(punchReqKey)).size + exBlocking, true],
          ['timeoff', 'Time Off', CalendarOff, pendingCount, decidableCount > 0],
          ...(hrTeam ? [] : [['invoices', 'Invoices', Receipt, invoiceDrafts, true]])].map(([key, label, Icon, badge, waiting]) => {
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
                <span title={waiting ? 'Waiting on you' : undefined} style={{ background: waiting ? 'var(--wk-red)' : on ? 'var(--wk-brand)' : 'var(--wk-faint)', color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '1px 7px', lineHeight: 1.4 }}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Range picker - shared by Insights and the Action Log's missing punches (both scan a range) */}
      {(view === 'insights' || view === 'actions') && (
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
      {rows === null && <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>}
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
                title={`${r.pendingEdits} time edit${r.pendingEdits === 1 ? '' : 's'} from this employee awaiting your review - click to open their Payroll time sheet and approve or reject each`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', border: 'none', padding: '3px 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
                <Pencil size={10} /> {r.pendingEdits} to review
              </button>
            )}
            {r.breakMin > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.breakMin}m break</span>}
            {(!LEGACY_APPROVE || isMe(r.email)) ? null : isRowApproved(r) ? (
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
                          <b>{KIND_LABEL[p.kind]}</b> {localTime(p.at, r.timeZone)}
                          {p.originalAt && <span title={`Originally ${localTime(p.originalAt, r.timeZone)} - adjusted by ${p.adjustedBy}`} style={{ color: '#b45309', fontWeight: 700 }}>✎</span>}
                          {p.lat && (
                            <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer"
                              title={`${p.geoStatus === 'in_fence' ? `At ${p.workSiteName}` : `${formatDistance(p.distanceM)} from ${p.workSiteName || 'nearest site'}`} (${formatAccuracy(p.accuracyM)})`}
                              style={{ display: 'inline-flex', color: p.geoStatus === 'out_of_fence' ? '#b45309' : p.geoStatus === 'in_fence' ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                              <MapPin size={11} />
                            </a>
                          )}
                          {p.source !== 'web' && <span title={p.source === 'self_manual' ? `Self-corrected: ${p.note}` : p.source === 'offline' ? `Recorded offline: ${p.note}` : `Added by ${p.createdBy}`} style={{ fontSize: 10, fontWeight: 800, color: '#b45309' }}>M</span>}
                          <button onClick={() => setEdit({ ...p, timeZone: r.timeZone, atInput: utcToInput(p.at, r.timeZone), adjustNote: '' })} title="Adjust / void"
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

      {/* Insights - activity dashboard (Top Apps / Websites / productivity), then
          the hours breakdown from the punch data. */}
      {view === 'insights' && (
        <div style={{ marginBottom: 18 }}>
          <TimeInsights start={start} end={end} people={(rows || []).map(r => ({ email: r.email, name: r.name }))} />
        </div>
      )}
      {view === 'insights' && (rows === null
        ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
        : (() => {
          const sorted = rows.filter(r => r.workedMin > 0).sort((a, b) => b.workedMin - a.workedMin);
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

      {/* Shifts moved out to its own module in My Desk (Sep 29) - views/Shifts.jsx. */}

      {/* Payroll - per-employee, per-pay-period editable timecard */}
      {view === 'payroll' && <PayrollReadiness onOpenTimecard={openTimecard} toastOk={toastOk} toastErr={toastErr} />}
      {/* California Review (Oct 18): CA-rule flags for HR - never the manager tier. */}
      {view === 'payroll' && !hrTeam && <CaReview onOpenTimecard={openTimecard} toastOk={toastOk} toastErr={toastErr} />}
      {view === 'payroll' && <PayrollTimecard key={payrollTarget.key} toastOk={toastOk} toastErr={toastErr} initialEmail={payrollEmail}
        initialStart={payrollTarget.start} initialPayType={payrollTarget.payType} />}
      {/* Retro Pay (Oct 17): back-dated rate changes on finalized periods. Pay - never the manager tier. */}
      {view === 'payroll' && !hrTeam && <RetroPayReport />}

      {/* Contractor invoices (Oct 21): drafted at finalize, approved and emailed here. */}
      {view === 'invoices' && !hrTeam && <ContractorInvoices toastOk={toastOk} toastErr={toastErr} onChanged={loadInvoiceDrafts} />}


      {/* Action Log (Neil, 10/06): punch-fix requests and missing punches were two
          tabs over the same job - get every timecard payable. One list now, one
          card per person carrying both: requests to approve or reject (tick
          several, decide in one go) and the punches still missing (fix on the
          timecard). Filter by department so HR can clear one team at a time;
          the server already limits it to the people you manage. A shift that
          is still running is not "missing" its clock-out. */}
      {view === 'actions' && (() => {
        const q = reqSearch.trim().toLowerCase();
        const kindRank = { in: 0, break_start: 1, break_end: 2, out: 3 };
        const people = new Map();
        const slot = (email, name, dept) => {
          const key = (email || name || '?').toLowerCase();
          if (!people.has(key)) people.set(key, { email, name: name || email, dept: dept || '', reqs: [], missing: [], blocking: 0 });
          const g = people.get(key);
          if (!g.dept && dept) g.dept = dept;
          if ((!g.name || g.name === g.email) && name) g.name = name;
          return g;
        };
        punchReqs.slice(0, 500).forEach(r => {
          const g = slot(r.employeeEmail, r.employeeName, r.department);
          g.reqs.push(r);
          // Seen only as someone's stand-in (approver delegation): "For <delegator>".
          if (r.forEmail) { g.forEmail = r.forEmail; g.forName = r.forName; }
        });
        (exceptions || []).forEach(r => {
          const g = slot(r.email, r.name || (rows || []).find(x => x.email === r.email)?.name, r.department);
          g.missing.push(...r.exceptions);
          g.blocking += r.blocking || 0;
        });
        const all = [...people.values()];
        const depts = [...new Set(all.map(g => g.dept).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        const matches = (g) => (!actDept || (actDept === '__none' ? !g.dept : g.dept === actDept))
          && (!q || (g.name || '').toLowerCase().includes(q) || (g.email || '').toLowerCase().includes(q)
            || g.reqs.some(r => (r.reason || '').toLowerCase().includes(q)));
        const inScope = all.filter(matches);
        const shown = inScope.map(g => ({
          ...g,
          reqs: actKind === 'missing' ? [] : [...g.reqs].sort((a, b) => (a.at || '').localeCompare(b.at || '') || ((kindRank[a.punchKind] ?? 9) - (kindRank[b.punchKind] ?? 9))),
          missing: actKind === 'requests' ? [] : g.missing,
        })).filter(g => g.reqs.length || g.missing.length)
          .map(g => {
            // Copies of the same fix (same person, punch and minute) are ONE
            // row with one Approve / Reject - deciding it closes the copies
            // (Visesh, Oct 7, carried into the Action Log).
            const byKey = new Map();
            g.reqs.forEach(r => {
              const k = punchReqKey(r);
              if (!byKey.has(k)) byKey.set(k, { rep: r, ids: [] });
              byKey.get(k).ids.push(r.id);
            });
            return { ...g, rows: [...byKey.values()] };
          })
          .sort((a, b) => (b.blocking - a.blocking) || (b.rows.length - a.rows.length) || (a.name || '').localeCompare(b.name || ''));
        const reqTotal = new Set(inScope.flatMap(g => g.reqs.map(punchReqKey))).size;
        const missTotal = inScope.reduce((n, g) => n + g.blocking, 0);
        const visibleIds = shown.flatMap(g => g.reqs.map(r => r.id));
        const selected = visibleIds.filter(id => selReqs.has(id));
        const selectedFixes = new Set(punchReqs.filter(r => selReqs.has(r.id) && visibleIds.includes(r.id)).map(punchReqKey)).size;
        const allSelected = visibleIds.length > 0 && selected.length === visibleIds.length;
        const filtered = !!(actDept || q || actKind !== 'all');
        const toggle = (ids, on) => setSelReqs(prev => { const n = new Set(prev); ids.forEach(id => on ? n.add(id) : n.delete(id)); return n; });
        // On the EMPLOYEE's clock, labeled when it is not the viewer's (Oct 19:
        // Miranda's 8:30 AM Pacific read 9:00 PM to her approver in India).
        const fmtAt = (at, tz) => { const z = zonedDateTime(at, tz); return z ? `${z.date}, ${z.label}` : ''; };
        const yourTime = (at, tz) => {
          if (!zonedDateTime(at, tz)?.differs) return undefined;
          const mine = zonedDateTime(at);
          return `Your time: ${mine.date}, ${mine.time}`;
        };
        const verb = (r) => {
          const kindLabel = { in: 'clock-in', out: 'clock-out', break_start: 'break start', break_end: 'break end' }[r.punchKind] || r.punchKind;
          return r.action === 'add' ? `Add a ${kindLabel}${r.category ? ` as ${r.category}` : ''}` : 'Remove a punch';
        };
        const cb = (checked, onChange, label) => (
          <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={label}
            style={{ width: 16, height: 16, accentColor: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', flexShrink: 0 }} />
        );
        const pill = (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: fg, background: bg, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap' });
        const seg = (k, label, n) => {
          const on = actKind === k;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => setActKind(k)}
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 600,
                background: on ? 'var(--wk-card, var(--card))' : 'transparent', color: on ? 'var(--wk-ink, var(--ink))' : 'var(--wk-dim, var(--muted))',
                boxShadow: on ? '0 1px 3px rgba(29,33,57,.12)' : 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {label}{n != null && <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', fontWeight: 700 }}>{n}</span>}
            </button>
          );
        };
        return (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div role="tablist" aria-label="Show" style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 8, background: 'var(--wk-hover)' }}>
                {seg('all', 'All', null)}
                {seg('requests', 'Punch Requests', reqTotal)}
                {seg('missing', 'Missing Punches', missTotal)}
              </div>
              <div style={{ position: 'relative', flex: '0 1 260px' }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--muted)' }} />
                <input value={reqSearch} onChange={e => setReqSearch(e.target.value)} placeholder="Search by name or reason" aria-label="Search the Action Log"
                  style={{ width: '100%', padding: '7px 10px 7px 30px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 12.5, background: 'var(--card)', color: 'var(--ink)', fontFamily: 'inherit' }} />
              </div>
              <select className="form-input" value={actDept} onChange={e => setActDept(e.target.value)} aria-label="Department"
                style={{ fontSize: 12.5, width: 'auto', minWidth: 170, padding: '6px 10px' }}>
                <option value="">All Departments</option>
                {depts.map(d => <option key={d} value={d}>{d}</option>)}
                {all.some(g => !g.dept) && <option value="__none">No Department</option>}
              </select>
              {filtered && (
                <button type="button" className="secondary-btn" onClick={() => { setActDept(''); setReqSearch(''); setActKind('all'); }}
                  style={{ fontSize: 12, padding: '5px 10px' }}>Clear Filters</button>
              )}
              {visibleIds.length > 0 && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer', marginLeft: 'auto' }}>
                  {cb(allSelected, on => toggle(visibleIds, on), 'Select every request shown')}
                  Select All Requests ({visibleIds.length})
                </label>
              )}
            </div>
            {selected.length > 0 && (
              <div style={{ position: 'sticky', top: 8, zIndex: 3, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 14px', marginBottom: 10,
                borderRadius: 12, background: 'var(--card)', border: '1px solid var(--wk-brand, #2b45e1)', boxShadow: 'var(--wk-shadow)' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{selectedFixes} request{selectedFixes === 1 ? '' : 's'} selected</span>
                <button type="button" className="secondary-btn" onClick={() => setSelReqs(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>Clear</button>
                <div style={{ flex: 1 }} />
                <button className="secondary-btn" disabled={bulkBusy} onClick={() => decideMany(selected, 'rejected')}
                  style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>Reject Selected</button>
                <button className="primary-btn" disabled={bulkBusy} onClick={() => decideMany(selected, 'approved')}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {bulkBusy ? <Spinner size={13} /> : <CheckCircle size={13} />} Approve Selected
                </button>
              </div>
            )}
            {exceptions === null && punchReqs.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
            ) : shown.length === 0 ? (
              <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={22} style={{ color: 'hsl(var(--color-green))' }} />
                {all.length && filtered
                  ? 'Nothing matches these filters.'
                  : 'All clear - no punch requests waiting and no missing punches in this range.'}
              </div>
            ) : shown.map(g => {
              const ids = g.reqs.map(r => r.id);
              const gSel = ids.filter(id => selReqs.has(id)).length;
              return (
                <div key={g.email || g.name} style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 14, marginBottom: 8, overflow: 'hidden', boxShadow: 'var(--wk-shadow)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                    {ids.length > 0 && cb(gSel === ids.length, on => toggle(ids, on), `Select every request from ${g.name}`)}
                    <Avatar email={g.email} name={g.name} size={32} />
                    {/* A 180px basis: on a phone the name keeps the first line and the
                        chips and buttons wrap below it, instead of squeezing it to "N..." (Oct 17). */}
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}{g.forEmail && <ForChip name={g.forName} email={g.forEmail} />}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.dept || 'No department'} · {g.email}
                      </div>
                    </div>
                    {g.rows.length > 0 && <span style={pill('var(--wk-brand-tint, rgba(43,69,225,0.08))', 'var(--wk-brand, #2b45e1)')}><Inbox size={11} /> {g.rows.length} Request{g.rows.length === 1 ? '' : 's'}</span>}
                    {g.blocking > 0 && actKind !== 'requests' && <span style={pill('rgba(220,38,38,0.08)', 'hsl(var(--color-red))')}><AlertTriangle size={11} /> {g.blocking} Missing</span>}
                    {g.email && g.missing.length > 0 && !isMe(g.email) && (
                      <button className="secondary-btn" onClick={() => setAddTimeFor({ email: g.email, name: g.name, dates: g.missing.filter(e => e.blocking).map(e => e.date) })}
                        title="Add the missing time - one or several days at once"
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Plus size={12} /> Add Time
                      </button>
                    )}
                    {ids.length > 1 && (
                      // Each day is approved on its own now (Charmi, Oct 21) - this
                      // still takes every request from this person in one click.
                      <button className="secondary-btn" disabled={bulkBusy} onClick={() => decideMany(ids, 'approved')}
                        title={`Approve every request from ${g.name}`}
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <CheckCircle size={12} /> Approve All ({g.rows.length})
                      </button>
                    )}
                    {g.email && (
                      <button className="secondary-btn" onClick={() => openTimecard(g.email, '', '')}
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Pencil size={12} /> Open Time Sheet
                      </button>
                    )}
                  </div>
                  {g.rows.map(({ rep: r, ids: rowIds }, i) => {
                    const focused = rowIds.includes(focusReq);
                    const rowSel = rowIds.some(id => selReqs.has(id));
                    return (
                    <div key={r.id} id={`punch-req-${r.id}`} data-req-ids={rowIds.join(' ')} className={rowSel || focused ? undefined : 'nx-needs-you--row'} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? '1px solid var(--line)' : 'none', flexWrap: 'wrap',
                      background: rowSel || focused ? 'var(--wk-brand-tint, rgba(43,69,225,0.06))' : 'transparent',
                      boxShadow: focused ? 'inset 3px 0 0 var(--wk-brand, #2b45e1)' : 'none' }}>
                      {cb(rowSel, on => toggle(rowIds, on), `Select request from ${g.name}`)}
                      <span style={pill('var(--wk-hover)', 'var(--ink)')}>Request</span>
                      <div style={{ flex: 1, minWidth: 240, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <span title={yourTime(r.at, r.timeZone)} style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtAt(r.at, r.timeZone) || 'No time'}</span>
                        <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>{verb(r)}</span>
                        {rowIds.length > 1 && (
                          <span title="The employee asked for the same punch more than once. Approving or rejecting it closes every copy."
                            style={pill('var(--wk-line2)', 'var(--ink)')}>
                            {rowIds.length} Requests - Same Punch
                          </span>
                        )}
                        {r.reason && <span style={{ fontSize: 12, color: 'var(--muted)' }}>"{r.reason}"</span>}
                      </div>
                      {r.action === 'add' && r.punchKind === 'in' && (
                        // The approver sets the Type here (Oct 21: "Please use sick time"
                        // in a note left a Personal block paid as Personal).
                        <select className="form-input" aria-label="Type" value={reqType[r.id] ?? (r.category || 'Regular')}
                          onChange={e => setReqType(m => ({ ...m, [r.id]: e.target.value }))}
                          style={{ fontSize: 12, width: 'auto', padding: '4px 8px' }}>
                          {['Regular', 'Sick', 'Vacation', 'Personal'].concat(r.category && !['Sick', 'Vacation', 'Personal'].includes(r.category) ? [r.category] : [])
                            .map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                      <button className="secondary-btn" disabled={bulkBusy} onClick={() => decidePunchReq(r.id, 'rejected')}
                        style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>Reject</button>
                      <button className="primary-btn" disabled={bulkBusy} onClick={() => decidePunchReq(r.id, 'approved')}
                        style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <CheckCircle size={13} /> Approve
                      </button>
                    </div>
                    );
                  })}
                  {g.missing.map((e, i) => (
                    <div key={`m${e.date}-${e.type}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', borderTop: (i || g.rows.length) ? '1px solid var(--line)' : 'none', fontSize: 12.5, flexWrap: 'wrap' }}>
                      <span title={e.blocking ? 'Blocks sign-off until fixed' : 'Worth a look - does not block sign-off'}
                        style={pill(e.blocking ? 'rgba(220,38,38,0.08)' : 'rgba(180,83,9,0.1)', e.blocking ? 'hsl(var(--color-red))' : '#b45309')}>
                        {e.blocking ? 'Missing' : 'Check'}
                      </span>
                      <span style={{ fontWeight: 800, width: 92, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{formatDate(e.date)}</span>
                      <span style={{ color: 'var(--ink)', flex: 1, minWidth: 200 }}>{e.label}</span>
                      <button className="secondary-btn" onClick={() => openTimecard(g.email, e.date, '')}
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Pencil size={12} /> Fix on Time Sheet
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
            {addTimeFor && (
              <AddTimeModal email={addTimeFor.email} name={addTimeFor.name} start={start} end={end} initialDates={addTimeFor.dates}
                onClose={() => setAddTimeFor(null)} onDone={() => loadExceptions()} toastOk={toastOk} toastErr={toastErr} />
            )}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
              Missing punches cover {rangeText}. A shift with no clock-out (or a clock-out with no clock-in) can't be paid until it's fixed.
              Someone still on the clock is not listed - their shift has not ended yet.
            </div>
          </div>
        );
      })()}

      {/* Time-off register - requests table, pending rows carry the decisions */}
      {view === 'timeoff' && (
        <>
        {(() => {
          const inRange = timeoff.filter(r => inPeriod(r, timeoffYear, timeoffMonth));
          const counts = countByStatus(inRange);
          const shownRows = filterAndSortTimeoff(inRange, timeoffFilter, timeoffSort);
          const periodSel = { fontSize: 12, padding: '4px 6px' };
          const chips = TIMEOFF_FILTERS.filter(([k]) => k !== 'cancelled' || counts.cancelled > 0 || timeoffFilter === 'cancelled');
          const sortHead = (key, label, style) => {
            const on = timeoffSort?.key === key;
            return (
              <button type="button" onClick={() => setTimeoffSort(cur => nextSort(cur, key))}
                aria-sort={on ? (timeoffSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                title={`Sort by ${label}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  font: 'inherit', color: on ? 'var(--ink)' : 'inherit', fontWeight: on ? 700 : 500, ...style }}>
                {label}
                <span aria-hidden="true" style={{ fontSize: 10, opacity: on ? 1 : 0.35 }}>{on ? (timeoffSort.dir === 'asc' ? '\u25B2' : '\u25BC') : '\u2195'}</span>
              </button>
            );
          };
          return (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div className="chip-row" role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginRight: 'auto' }}>
            {chips.map(([k, label]) => {
              const on = timeoffFilter === k;
              return (
                <button key={k} type="button" onClick={() => setTimeoffFilter(k)} aria-pressed={on}
                  style={{ padding: '6px 14px', borderRadius: 10, border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`,
                    background: on ? 'var(--wk-brand-tint)' : 'var(--card)', color: on ? 'var(--wk-brand)' : 'var(--muted)',
                    fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'var(--wk-font)', whiteSpace: 'nowrap' }}>
                  {label} ({counts[k]})
                </button>
              );
            })}
          </div>
          <select className="form-input" aria-label="Year" value={timeoffYear} onChange={e => setTimeoffYear(e.target.value)} style={periodSel}>
            <option value="">All Years</option>
            {yearsOf(timeoff).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="form-input" aria-label="Month" value={timeoffMonth} onChange={e => setTimeoffMonth(e.target.value)} style={periodSel}>
            <option value="">All Months</option>
            {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
              .map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
          </select>
          <button className="primary-btn" onClick={() => setObo({ email: '', type: 'vacation', start: '', end: '', note: '', confidential: false })}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}>
            <Plus size={13} /> Request on Behalf
          </button>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--wk-shadow)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, padding: '10px 14px', background: 'var(--wk-hover)', fontSize: 12.5, fontWeight: 500, color: 'var(--wk-dim)' }}>
            <span>{sortHead('name', 'Requested By')}</span><span>Type</span><span>{sortHead('period', 'Period')}</span><span>Days</span><span>Approver</span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>{sortHead('status', 'Status')}</span>
          </div>
          {timeoffErr ? (
            <div style={{ padding: '14px 16px' }}><ErrorBanner message="Couldn't load time-off requests right now." onRetry={loadTimeoff} /></div>
          ) : shownRows.length === 0 && (
            <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
              {timeoff.length === 0 ? 'No time-off requests yet.'
                : timeoffYear || timeoffMonth ? 'No requests in that period.'
                : timeoffFilter === 'pending' ? 'No requests are waiting for a decision.'
                : `No ${timeoffFilter} requests.`}
              {timeoff.length > 0 && (
                <button type="button" className="secondary-btn" onClick={() => { setTimeoffFilter('all'); setTimeoffYear(''); setTimeoffMonth(''); }}
                  style={{ fontSize: 12, padding: '4px 10px', marginLeft: 8 }}>Show All</button>
              )}
            </div>
          )}
          {shownRows.slice(0, 150).map(r => {
            // Working days (Mon-Fri), a partial day as its share of 8 hours - the
            // same count the employee sees on their Time Off tab (lib/workdayStats.js).
            const days = leaveRequestDays(r);
            // Partial-day request (Charmi, Aug 21): show its hour window and count
            // the fraction of an 8-hour day instead of a full day.
            const hm12 = (v) => { const [h, m] = (v || '').split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
            const partial = r.startTime && r.endTime;
            return (
              <div key={r.id} className={r.status === 'pending' && r.canDecide !== false ? 'nx-needs-you--row' : undefined} style={{ display: 'grid', gridTemplateColumns: '200px 110px 1fr 70px 160px 170px', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: r.status === 'pending' ? 'rgba(251,191,36,0.05)' : 'transparent' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.email}{r.forEmail && <ForChip name={r.forName} email={r.forEmail} />}</span>
                <span style={{ fontSize: 12, textTransform: 'capitalize', display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {timeoffLabel(r)}{r.confidential && <ConfidentialMark />}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }} title={r.note || undefined}>
                  {formatDate(r.startDate, r.startDate)} - {formatDate(r.endDate, r.endDate)}{partial ? ` · ${hm12(r.startTime)} - ${hm12(r.endTime)}` : ''}{r.note ? ` · Reason: ${r.note}` : r.redacted ? '' : ' · No reason given'}
                  {r.requestedBy && r.requestedBy !== r.email && (
                    <span style={{ fontStyle: 'italic' }}> · filed by {r.requestedByName || r.requestedBy.split('@')[0].replace(/\./g, ' ')}</span>
                  )}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700 }} title="Working days (Mon-Fri)">{r.startDate ? fmtDays(days) : '-'}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.approver || '-'}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  {r.status === 'pending' && r.canDecide === false ? (
                    // Your own request, or a confidential one that is not
                    // yours to decide (Sep 29): say who decides instead.
                    <span style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}
                      title={r.awaitingHr ? `Approved by ${r.firstApproverName || r.firstApprover || 'the manager'} - HR approves next` : r.confidential ? 'Confidential - only the approver can decide it' : undefined}>
                      {r.awaitingHr ? 'Awaiting HR Approval' : r.reviewer ? `Pending - ${r.reviewer} decides` : 'Pending - your manager decides'}
                    </span>
                  ) : r.status === 'pending' ? (<>
                    {r.awaitingHr && <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }} title={`Approved by ${r.firstApproverName || r.firstApprover || 'the manager'}`}>HR Approval</span>}
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
          {shownRows.length > 150 && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>Showing 150 of {shownRows.length} - filter to narrow down.</div>}
        </div>
        </>);
        })()}
        <TeamLeaveCalendar />
        {hrPanels && !hrTeam && (<>
          <LeaveYearEndPreview toastOk={toastOk} toastErr={toastErr} />
          <LeaveBalancesAdmin toastOk={toastOk} toastErr={toastErr} />
          <ApprovalDelegationsAdmin toastOk={toastOk} toastErr={toastErr} />
          <LeaveHistory />
        </>)}
        </>
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
            <div className="nx-popup" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--wk-brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                  {p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email} · {formatDate(start)} - {formatDate(end)}</div>
                </div>
                {LEGACY_APPROVE && !isMe(p.email) && (() => {
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
                  <AdminDayRow key={date} date={date} email={p.email} d={p.days[date]} timeZone={p.timeZone}
                    approval={(p.dayApprovals || {})[date]}
                    onApprove={isMe(p.email) ? null : () => approveDays(p.email, [date])} />
                ))}
                {Object.keys(p.days || {}).length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No punches in this range.</div>}

                <div style={{ ...HD, margin: '18px 0 8px' }}>Time off</div>
                {myOff.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No requests on record.</div>}
                {myOff.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, textTransform: 'capitalize', width: 80, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {timeoffLabel(t)}{t.confidential && <ConfidentialMark />}
                    </span>
                    <span style={{ color: 'var(--muted)', flex: 1 }}>{formatDate(t.startDate, t.startDate)} - {formatDate(t.endDate, t.endDate)}{t.note ? ` · Reason: ${t.note}` : ''}</span>
                    <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'capitalize', padding: '2px 10px', borderRadius: 999,
                      background: t.status === 'approved' ? 'hsla(var(--color-green),0.1)' : t.status === 'rejected' ? 'rgba(185,28,28,0.08)' : 'rgba(180,83,9,0.1)',
                      color: t.status === 'approved' ? 'hsl(var(--color-green))' : t.status === 'rejected' ? '#b91c1c' : '#b45309' }}>{t.status}</span>
                  </div>
                ))}
                <p style={{ margin: '14px 0 0', fontSize: 10.5, color: 'var(--muted)' }}>
                  To correct a punch, use the pencil on the Time Sheets list. Screenshots (if captured) are in Workforce Analytics.
                </p>
              </div>
            </div>
          </div>
        );
      })(), document.body)}

      {/* Edit punch modal */}
      {edit && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && editGuard.requestClose()}>
          <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="wkc-chip"><Clock size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Adjust punch - {KIND_LABEL[edit.kind]}</h3>
              <button onClick={editGuard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {edit.originalAt && (
                <p style={{ margin: 0, fontSize: 11.5, color: '#b45309' }}>Original time on record: {localTime(edit.originalAt, edit.timeZone)} (adjusted by {edit.adjustedBy})</p>
              )}
              <div><label style={FL}>Time{zoneTag(edit.timeZone) ? ` (${zoneTag(edit.timeZone)}, the employee's clock)` : ''}</label>
                <input className="form-input" type="datetime-local" value={edit.atInput}
                  onChange={e => { setLongWarn(null); setEdit(x => ({ ...x, atInput: e.target.value })); }} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Punch note</label>
                <input className="form-input" value={edit.note || ''} onChange={e => setEdit(x => ({ ...x, note: e.target.value }))} style={{ width: '100%' }} /></div>
              <div className="nx-fill"><label style={FL}>Reason for adjustment</label>
                <textarea className="form-input" rows={3} placeholder="Shows in the audit trail" value={edit.adjustNote}
                  onChange={e => setEdit(x => ({ ...x, adjustNote: e.target.value }))} style={{ width: '100%', fontFamily: 'inherit' }} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!edit.voided} onChange={e => setEdit(x => ({ ...x, voided: e.target.checked }))}
                  style={{ width: 15, height: 15, accentColor: '#b91c1c' }} />
                <Ban size={13} style={{ color: '#b91c1c' }} /> Void this punch (kept on record, excluded from totals)
              </label>
              <LongShiftWarning issue={longWarn?.form === 'edit' ? longWarn.issue : null} manager busy={busy}
                onFix={() => setLongWarn(null)}
                onUseSuggestion={(w) => { setLongWarn(null); setEdit(x => ({ ...x, atInput: w.suggest })); }}
                onConfirm={() => saveEdit({ confirmLong: true })} />
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveEdit} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Save
              </button>
            </div>
          </div>
        </div>
      , document.body)}
      {editGuard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={editGuard.keepEditing} onDiscard={() => setEdit(null)} onSave={editGuard.saveAndClose} saving={editGuard.saving || busy} />
      )}

      {/* Request-on-behalf modal (Neil, Aug 11): a normal pending request in the
          employee's name, stamped with who filed it; the employee is notified. */}
      {obo && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && oboGuard.requestClose()}>
          <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="wkc-chip"><CalendarOff size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Request Time Off on Behalf</h3>
              <button onClick={oboGuard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div><label style={FL}>Employee</label>
                <select className="form-input" value={obo.email} onChange={e => setObo(p => ({ ...p, email: e.target.value }))} style={{ width: '100%' }}>
                  <option value="">Choose…</option>
                  {(rows || []).map(r => <option key={r.email} value={r.email}>{r.name || r.email}</option>)}
                </select></div>
              <div><label style={FL}>Type</label>
                <select className="form-input" value={obo.type} onChange={e => setObo(p => ({ ...p, type: e.target.value }))} style={{ width: '100%' }}>
                  {/* No Unpaid (Neil, Oct 12 2026): the server no longer accepts it - Personal is unpaid anyway. */}
                  {['vacation', 'sick', 'personal', 'other'].map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                  {oboReasons.map(t => <option key={t} value={t}>{t}</option>)}
                </select></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div><label style={FL}>First day</label>
                  <input className="form-input" type="date" value={obo.start} onChange={e => setObo(p => ({ ...p, start: e.target.value }))} style={{ width: '100%' }} /></div>
                <div><label style={FL}>Last day</label>
                  <input className="form-input" type="date" value={obo.end} onChange={e => setObo(p => ({ ...p, end: e.target.value }))} style={{ width: '100%' }} /></div>
              </div>
              <div className="nx-fill"><label style={FL}>Reason</label>
                <textarea className="form-input" rows={3} aria-label="Reason" placeholder="Why they are off, e.g. called in sick this morning" value={obo.note}
                  onChange={e => setObo(p => ({ ...p, note: e.target.value }))} style={{ width: '100%', fontFamily: 'inherit' }} /></div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!obo.confidential} onChange={e => setObo(p => ({ ...p, confidential: e.target.checked }))} style={{ marginTop: 2 }} />
                <span>
                  <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Keep this confidential</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Others see the type of time off and the dates. The reason is visible only to them and their approver.
                  </span>
                </span>
              </label>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Filed as a normal pending request in their name - they get a notification, and it still needs an approval.
              </div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setObo(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveObo} disabled={oboBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {oboBusy ? <Spinner size={13} /> : <CheckCircle size={13} />} File Request
              </button>
            </div>
          </div>
        </div>
      , document.body)}
      {oboGuard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={oboGuard.keepEditing} onDiscard={() => setObo(null)} onSave={oboGuard.saveAndClose} saving={oboGuard.saving || oboBusy} />
      )}

      {/* Add punch modal */}
      {addFor && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && addGuard.requestClose()}>
          <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="wkc-chip"><Plus size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add punch - {addFor}</h3>
              <button onClick={addGuard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div><label style={FL}>Kind</label>
                <select className="form-input" value={addP.kind} onChange={e => setAddP(p => ({ ...p, kind: e.target.value }))} style={{ width: '100%' }}>
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
              <div><label style={FL}>{(() => { const t = zoneTag((rows || []).find(x => x.email === addFor)?.timeZone); return t ? `Time (${t}, the employee's clock)` : 'Time'; })()}</label>
                <input className="form-input" type="datetime-local" value={addP.at} onChange={e => { setLongWarn(null); setAddP(p => ({ ...p, at: e.target.value })); }} style={{ width: '100%' }} /></div>
              <div className="nx-fill"><label style={FL}>Note</label>
                <textarea className="form-input" rows={3} placeholder="e.g. forgot to punch out" value={addP.note}
                  onChange={e => setAddP(p => ({ ...p, note: e.target.value }))} style={{ width: '100%', fontFamily: 'inherit' }} /></div>
              <LongShiftWarning issue={longWarn?.form === 'add' ? longWarn.issue : null} manager busy={busy}
                onFix={() => setLongWarn(null)}
                onUseSuggestion={(w) => { setLongWarn(null); setAddP(p => ({ ...p, at: w.suggest })); }}
                onConfirm={() => saveAdd({ confirmLong: true })} />
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setAddFor(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveAdd} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Add
              </button>
            </div>
          </div>
        </div>
      , document.body)}
      {addGuard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={addGuard.keepEditing} onDiscard={() => setAddFor(null)} onSave={addGuard.saveAndClose} saving={addGuard.saving || busy} />
      )}
    </div>
  );
}
