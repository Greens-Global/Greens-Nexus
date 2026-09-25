// Workday widgets (phase 2 of the dashboard widget plan, Neil, Sep 24) - the
// four tiles every employee can use, all backed by endpoints that already
// existed: Time Clock (status + hours, hands off to the Time Clock screen for
// the punch itself), My Requests (time off + punch corrections + Ask HR in one
// list), Due Back Soon (my checkouts by due date + assignments waiting on my
// accept) and Coming Up (birthdays and company holidays as a short list).
//
// Loaded lazily from widgets.jsx (same as panels.jsx) so the main dashboard
// bundle does not grow; DashCard / navigate come from widgets.jsx so these
// read exactly like every other tile.
import { useState, useEffect } from 'react';
import { ArrowRight, Cake, CalendarDays, Clock, Package, HandCoins } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDate, formatTime, formatDateLong } from '../lib/datetime';
import { DashCard, navigate } from './widgets.jsx';

const noteStyle = { fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 };
const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const DAY_MS = 86400000;
// Local calendar date as YYYY-MM-DD - the key the time clock's `days` map uses.
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
// Midnight-to-midnight day difference in local time (negative = past).
const daysUntil = (d, now) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);

// One list row: icon chip, title + meta, a status word on the right. Flat -
// color is a dot and the word, never a pill (Neil's editorial style).
const STATUS_TONE = {
  pending: 'orange', open: 'orange', approved: 'green', resolved: 'green',
  rejected: 'red', overdue: 'red', cancelled: 'muted', canceled: 'muted',
};
function Row({ Icon, title, meta, status, statusLabel, onClick }) {
  const tone = STATUS_TONE[status] || 'blue';
  const color = tone === 'muted' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
  // No onClick = a plain, non-interactive row (Coming Up: there is no screen
  // an employee can open for a birthday - People is supervisor-only).
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={onClick ? 'dash-link-row' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px', border: 'none', background: 'none', borderRadius: 8, cursor: onClick ? 'pointer' : 'default', textAlign: 'left', fontFamily: 'var(--wk-font)', width: '100%', color: 'var(--ink)', boxSizing: 'border-box' }}
      onMouseEnter={onClick ? (e => e.currentTarget.style.background = 'var(--mist)') : undefined}
      onMouseLeave={onClick ? (e => e.currentTarget.style.background = 'none') : undefined}>
      {Icon && <span className="dk-chip dk-chip--blue" style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0 }}><Icon size={14} /></span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        {meta && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{meta}</span>}
      </span>
      {statusLabel && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color, flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} /> {statusLabel}
        </span>
      )}
    </Tag>
  );
}

// ── Time Clock ───────────────────────────────────────────────────────────────
// Status, a live "today" total and the last 7 days, from /timeclock/status -
// the same call Home's "My hours" pane makes. The punch itself stays on the
// Time Clock screen (day-message gate, geolocation, agent pairing, the
// never-lose-a-punch queue) - this tile only hands off there. Re-fetches when
// the tab regains focus so a punch made on the Time Clock screen or from the
// floating pill shows up here without a reload.
export function TimeClockWidget() {
  const [status, setStatus] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    const load = () => api.timeStatus().then(s => { if (alive) setStatus(s || {}); }).catch(() => { if (alive) setStatus(s => s || { error: true }); });
    load();
    const onFocus = () => { if (document.visibilityState !== 'hidden') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const t = setInterval(load, 120000);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out') && !status?.staleOpenShift;
  const onBreak = clockedIn && last?.kind === 'break_start';
  const elapsedMin = clockedIn && !onBreak && last?.at ? Math.max(0, Math.floor((now - utc(last.at)) / 60000)) : 0;
  const days = status?.days || {};
  let todayMin = (days[localKey(now)]?.workedMin || 0) + elapsedMin;
  let weekMin = elapsedMin;
  for (let i = 0; i < 7; i++) weekMin += days[localKey(new Date(now.getTime() - i * DAY_MS))]?.workedMin || 0;

  const state = !status ? '' : status.error ? 'Unavailable' : onBreak ? 'On Break' : clockedIn ? 'Clocked In' : 'Clocked Out';
  const tone = onBreak ? 'orange' : clockedIn ? 'green' : 'muted';
  const stateColor = tone === 'muted' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
  const since = last?.at ? `${{ in: 'In', out: 'Out', break_start: 'Break', break_end: 'Back' }[last.kind] || last.kind} at ${formatTime(utc(last.at))}` : '';
  const go = () => navigate('timeclock', 'clock');

  if (status?.timeTrackingExempt) {
    return (
      <DashCard title="Time Clock" action={<Clock size={15} style={{ color: 'var(--muted)' }} />}>
        <div style={noteStyle}>Time tracking is not required for your role.</div>
      </DashCard>
    );
  }
  return (
    <DashCard title="Time Clock" sub={since || undefined} action={<Clock size={15} style={{ color: 'var(--muted)' }} />}>
      {!status ? (
        <div style={noteStyle}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: stateColor }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: stateColor }} /> {state}
          </div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.1, color: 'var(--wk-ink, var(--ink))', fontVariantNumeric: 'tabular-nums' }}>{fmtH(todayMin)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Today</div>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtH(weekMin)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Last 7 days</div>
            </div>
          </div>
          <button type="button" className="secondary-btn" onClick={go} style={{ marginTop: 'auto', alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {clockedIn ? 'Open Time Clock' : 'Punch In'} <ArrowRight size={13} />
          </button>
        </div>
      )}
    </DashCard>
  );
}

// ── My Requests ──────────────────────────────────────────────────────────────
// Time off, punch corrections and Ask HR requests are three separate lists on
// two screens; here they are one. Pending first, then anything decided in the
// last 14 days (Neil, Sep 24) so an approval or rejection is not missed.
// Each row opens the screen that owns it.
const TIMEOFF_TYPES = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
const HR_REQ_LABEL = { document: 'Document update', profile: 'Profile change', question: 'Question', other: 'Request' };
const PUNCH_KIND = { in: 'Punch In', out: 'Punch Out', break_start: 'Break Start', break_end: 'Break End' };
const DECIDED_WINDOW_DAYS = 14;

export function normalizeRequests({ timeOff = [], punch = [], hr = [] }, now = new Date()) {
  const rows = [];
  for (const r of timeOff) {
    const range = r.endDate && r.endDate !== r.startDate ? `${formatDate(r.startDate)} - ${formatDate(r.endDate)}` : formatDate(r.startDate);
    rows.push({ id: `to-${r.id}`, Icon: CalendarDays, title: `${TIMEOFF_TYPES[r.type] || r.type || 'Time off'} · ${range}`, meta: 'Time off',
      status: r.status, at: r.decidedAt || r.createdAt, createdAt: r.createdAt, nav: ['timeclock', 'timeoff'] });
  }
  for (const r of punch) {
    const what = `${r.action === 'add' ? 'Add' : r.action === 'remove' ? 'Remove' : 'Fix'} ${PUNCH_KIND[r.punchKind] || r.punchKind || 'punch'}`;
    rows.push({ id: `pr-${r.id}`, Icon: Clock, title: `${what} · ${formatDate(r.localDate || r.at)}`, meta: 'Punch correction',
      status: r.status, at: r.decidedAt || r.createdAt, createdAt: r.createdAt, nav: ['timeclock', 'timesheet'] });
  }
  for (const r of hr) {
    rows.push({ id: `hr-${r.id}`, Icon: HandCoins, title: HR_REQ_LABEL[r.type] || 'HR request', meta: (r.message || '').slice(0, 60) || 'Ask HR',
      status: r.status === 'open' ? 'pending' : r.status, at: r.resolvedAt || r.createdAt, createdAt: r.createdAt, nav: ['myhr', null] });
  }
  const cutoff = now.getTime() - DECIDED_WINDOW_DAYS * DAY_MS;
  const isPending = (s) => s === 'pending' || s === 'open';
  return rows
    .filter(r => isPending(r.status) || (r.at && new Date(r.at).getTime() >= cutoff))
    .sort((a, b) => (isPending(b.status) - isPending(a.status)) || (new Date(b.at || 0) - new Date(a.at || 0)));
}

export function MyRequestsWidget() {
  const [state, setState] = useState({ loading: true, rows: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.timeOffMine().catch(() => []),
      api.timeMyPunchRequests().catch(() => []),
      api.myHrRequests().catch(() => []),
    ]).then(([timeOff, punch, hr]) => {
      if (alive) setState({ loading: false, rows: normalizeRequests({ timeOff: timeOff || [], punch: punch || [], hr: hr || [] }) });
    });
    return () => { alive = false; };
  }, []);
  const pending = state.rows.filter(r => r.status === 'pending').length;
  return (
    <DashCard title="My Requests" sub={state.loading ? undefined : pending ? `${pending} waiting on a decision` : 'Nothing waiting'}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.rows.length === 0 ? (
        <div style={noteStyle}>No open requests. Time off, punch corrections and HR requests show up here.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.rows.slice(0, 10).map(r => (
            <Row key={r.id} Icon={r.Icon} title={r.title} meta={r.meta} status={r.status}
              statusLabel={r.status === 'pending' ? 'Pending' : r.status.charAt(0).toUpperCase() + r.status.slice(1)}
              onClick={() => navigate(r.nav[0], r.nav[1])} />
          ))}
        </div>
      )}
    </DashCard>
  );
}

// ── Due Back Soon ────────────────────────────────────────────────────────────
// My transient checkouts by due date - due counts from handover, not request
// (CLAUDE.md), so it is handover + approved days - plus any permanent
// assignment still waiting for my one-click accept. Overdue first.
const WITH_ME = new Set(['approved', 'pending_receipt', 'allocated']);

export function dueRows(checkouts = [], assignments = [], myEmail = '', now = new Date()) {
  const me = (myEmail || '').toLowerCase();
  const rows = [];
  for (const c of checkouts) {
    if (!WITH_ME.has(c.status)) continue;
    if (me && (c.requested_by_email || '').toLowerCase() !== me) continue;
    let due = null, dayDiff = null;
    if (c.handed_over_at) {
      due = new Date(new Date(c.handed_over_at).getTime() + (Number(c.days) || 0) * DAY_MS);
      dayDiff = daysUntil(due, now);
    }
    const status = dayDiff == null ? 'pending' : dayDiff < 0 ? 'overdue' : dayDiff <= 1 ? 'soon' : 'ok';
    const label = dayDiff == null ? 'Awaiting handover'
      : dayDiff < 0 ? `Overdue ${-dayDiff} ${-dayDiff === 1 ? 'day' : 'days'}`
      : dayDiff === 0 ? 'Due today' : dayDiff === 1 ? 'Due tomorrow' : `Due in ${dayDiff} days`;
    rows.push({ id: `co-${c.id}`, Icon: Package, title: c.item_name, meta: due ? `Return by ${formatDate(due)}` : 'Approved, not yet handed over',
      status, statusLabel: label, sort: dayDiff == null ? 1e6 : dayDiff, nav: ['inventory', 'checkouts'] });
  }
  for (const a of assignments) {
    if (a.status !== 'pending_acceptance') continue;
    if (me && (a.assignee_email || '').toLowerCase() !== me) continue;
    rows.push({ id: `as-${a.id}`, Icon: HandCoins, title: a.item_name, meta: `Assigned by ${a.assigned_by || 'your manager'}`,
      status: 'pending', statusLabel: 'Accept', sort: -1e6, nav: ['inventory', null] });
  }
  return rows.sort((a, b) => a.sort - b.sort);
}

export function DueBackWidget() {
  const { myEmail } = useRole();
  const [state, setState] = useState({ loading: true, rows: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([api.getItemCheckouts().catch(() => []), api.getAssignments().catch(() => [])])
      .then(([c, a]) => { if (alive) setState({ loading: false, rows: dueRows(c || [], a || [], myEmail) }); });
    return () => { alive = false; };
  }, [myEmail]);
  const overdue = state.rows.filter(r => r.status === 'overdue').length;
  return (
    <DashCard title="Due Back Soon" sub={state.loading ? undefined : overdue ? `${overdue} overdue` : state.rows.length ? `${state.rows.length} with you` : undefined}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.rows.length === 0 ? (
        <div style={noteStyle}>Nothing due back. Items you check out show up here as their return date nears.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.rows.slice(0, 10).map(r => (
            <Row key={r.id} Icon={r.Icon} title={r.title} meta={r.meta} status={r.status === 'soon' ? 'pending' : r.status === 'ok' ? 'approved' : r.status}
              statusLabel={r.statusLabel} onClick={() => navigate(r.nav[0], r.nav[1])} />
          ))}
        </div>
      )}
    </DashCard>
  );
}

// ── Coming Up ────────────────────────────────────────────────────────────────
// The next birthdays (roster-wide, month/day only) and company holidays as a
// short list. The Calendar widget overlays the same data on its month grid;
// this is the cheap 3x3 version for boards without an 8x5 calendar.
const LOOKAHEAD_DAYS = 30;

export function comingUpRows(birthdays = [], holidays = [], now = new Date()) {
  const rows = [];
  for (const b of birthdays) {
    let d = new Date(now.getFullYear(), b.month - 1, b.day);
    let diff = daysUntil(d, now);
    if (diff < 0) { d = new Date(now.getFullYear() + 1, b.month - 1, b.day); diff = daysUntil(d, now); }
    if (diff <= LOOKAHEAD_DAYS) rows.push({ id: `b-${b.name}-${b.month}-${b.day}`, Icon: Cake, title: b.name, meta: 'Birthday', diff, date: d });
  }
  for (const h of holidays) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(h.date || '');
    if (!m) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const diff = daysUntil(d, now);
    if (diff >= 0 && diff <= LOOKAHEAD_DAYS) rows.push({ id: `h-${h.date}-${h.name}`, Icon: CalendarDays, title: h.name, meta: h.type === 'optional' ? 'Optional holiday' : 'Company holiday', diff, date: d });
  }
  return rows.sort((a, b) => a.diff - b.diff || a.title.localeCompare(b.title));
}
const whenLabel = (r) => r.diff === 0 ? 'Today' : r.diff === 1 ? 'Tomorrow' : formatDateLong(r.date);

export function ComingUpWidget() {
  const [state, setState] = useState({ loading: true, rows: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([api.dashBirthdays().catch(() => ({})), api.dashHolidays().catch(() => ({}))])
      .then(([b, h]) => { if (alive) setState({ loading: false, rows: comingUpRows(b?.birthdays || [], h?.holidays || []) }); });
    return () => { alive = false; };
  }, []);
  return (
    <DashCard title="Coming Up" sub="Next 30 days" action={<Cake size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.rows.length === 0 ? (
        <div style={noteStyle}>No birthdays or holidays in the next 30 days.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.rows.slice(0, 8).map(r => (
            <Row key={r.id} Icon={r.Icon} title={r.title} meta={r.meta} statusLabel={whenLabel(r)} status={r.diff === 0 ? 'approved' : 'info'} />
          ))}
        </div>
      )}
    </DashCard>
  );
}
