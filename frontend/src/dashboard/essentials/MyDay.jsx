// My Day (Essentials, Oct 7) - "what needs me right now?" for everyone.
// Registered as 'my-day' in widgets.jsx, its own lazy chunk so it loads only
// when the tile is on the board.
//
// The data is the Daily Briefing's own Action Required section
// (api.getMyBriefing -> GET /daily-briefing/me, built by
// backend/daily_briefing.py build_sections / _red_rows): task approvals,
// a report's time off, time card sign-offs, timesheets to review, punch
// fixes, shift requests, item handovers, ticket approvals and assignments,
// signatures, and the tasks due today. One-click decisions and Complete go
// through api.actOnMyBriefing (POST /daily-briefing/me/act), the same code
// path My Briefing and the email links use, so permissions and notifications
// behave exactly as they do everywhere else. Everything else hands off to the
// screen that owns it. DashCard / navigate come from widgets.jsx, Row /
// noteStyle from workdayWidgets.jsx, so this tile reads like every other one.
import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, ArrowRight, CalendarCheck, CalendarClock, CheckSquare, ClipboardCheck, Clock, FileSignature, LifeBuoy, Package, Timer } from 'lucide-react';

import { api } from '../../api';
import { LoadingState } from '../../components/AsyncState';
import { formatDate } from '../../lib/datetime';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { useIsMobile } from '../../lib/useIsMobile';
import { openNotificationTarget } from '../../lib/openTarget';
import { DashCard, navigate } from '../widgets.jsx';
import { Row, noteStyle } from '../workdayWidgets.jsx';

export const MAX_ROWS = 7;
const POLL_MS = 60000;
const DAY_MS = 86400000;
// Urgency classes, most urgent first.
export const OVERDUE = 0, DUE_TODAY = 1, WAITING = 2;

// Icon by kind. The briefing row carries a module and, for decisions, the
// decision kind; the row's wording tells the rest apart (same strings
// _red_rows writes - see backend/daily_briefing.py).
const KIND_ICON = {
  approval: ClipboardCheck, signature: FileSignature, timecard: Clock, timesheet_review: CalendarCheck,
  ticket: LifeBuoy, task: CheckSquare, punch: Timer, shift: CalendarClock, item: Package, other: ArrowRight,
};

// Server path -> the app's view/sub (mirrors App.jsx parsePath for the paths
// the briefing emits: /tasks/mine?task=, /tickets?ticket=, /support?ticket=,
// /timeclock[/timesheet], /documents/documents-esign, /hr/hr-time-requests,
// /shifts/mine|schedule, /itemmanagement).
const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory', construction: 'ops', ops: 'ops' };
export function targetFor(path) {
  if (!path) return null;
  let p = path;
  if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { return null; } }
  const [pathname, query = ''] = p.split('?');
  const segs = pathname.split('/').filter(Boolean);
  const raw = segs[0] || 'dashboard';
  const params = new URLSearchParams(query);
  if (raw === 'tasks' && segs[1] === 'tickets') return { view: 'tickets', sub: null, taskId: '', ticketId: params.get('ticket') || '' };
  return { view: PATH_TO_VIEW[raw] || raw, sub: segs[1] || null, taskId: params.get('task') || '', ticketId: params.get('ticket') || '' };
}

function classify(r) {
  const title = r.title || '';
  if (r.decision) return 'approval';
  if (r.module === 'documents') return 'signature';
  if (r.module === 'timecard') return /^Review /.test(title) ? 'timesheet_review' : /timesheet fix/i.test(title) ? 'punch' : 'timecard';
  if (r.module === 'tickets') return 'ticket';
  if (r.module === 'shifts') return 'shift';
  if (r.module === 'items') return 'item';
  if (r.taskId) return 'task';
  return 'other';
}

const ACTION_LABEL = { approval: 'Approve', signature: 'Sign', task: 'Complete', punch: 'Fix Punch' };
const actionFor = (kind) => ({ type: kind === 'approval' ? 'decision' : kind === 'task' ? 'complete' : 'nav', label: ACTION_LABEL[kind] || 'Open' });

const DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysFromToday = (d, now) => Math.round((midnight(d) - midnight(now)) / DAY_MS);
function datesIn(text) {
  const out = [];
  for (const m of (text || '').matchAll(DATE_RE)) out.push(new Date(+m[3], +m[1] - 1, +m[2]));
  return out;
}

// Overdue before due today before waiting on me. The rows carry no dates of
// their own, so this reads the wording _red_rows / due_task_rows write: a
// closed pay period or an overdue task is overdue; "Due today" and a pay
// period closing today are due today; a report's time off that has already
// started is due today, and one that has already ended is overdue.
export function urgencyOf(r, now = new Date()) {
  const detail = r.detail || '';
  if (/overdue|is closed/i.test(detail)) return OVERDUE;
  if (/^Due today/i.test(detail)) return DUE_TODAY;
  const dates = datesIn(detail);
  if (/\bcloses\b/i.test(detail) && dates.length) return daysFromToday(dates[0], now) <= 0 ? DUE_TODAY : WAITING;
  if (r.module === 'time_off' && dates.length) {
    const first = daysFromToday(dates[0], now), last = daysFromToday(dates[dates.length - 1], now);
    if (last < 0) return OVERDUE;
    if (first <= 0) return DUE_TODAY;
  }
  return WAITING;
}

// Relative age for a row that carries a timestamp (createdAt / since / at);
// older than a week falls back to the date. The briefing rows do not carry
// one today, so this is ready for the day they do.
export function ageLabel(iso, now = new Date()) {
  if (!iso) return '';
  const t = new Date(/Z|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  if (mins < 7 * 24 * 60) return `${Math.floor(mins / (24 * 60))}d`;
  return formatDate(new Date(t));
}

// The pure row builder: the briefing payload in, the tile's rows out, most
// urgent first, then oldest first (server order when the rows carry no
// timestamp). A bundled time-off row (several requests, one card) becomes
// one row per request so each has exactly one Approve / Reject.
export function buildMyDayRows(data, now = new Date()) {
  const section = (data?.sections || []).find((s) => s.key === 'action_required');
  const rows = [];
  (section?.rows || []).forEach((r, i) => {
    const stamp = r.createdAt || r.since || r.at || '';
    const base = { module: r.module || 'other', title: r.title || '', path: r.path || '', taskId: r.taskId || '', stamp, order: i };
    if (r.subDecisions?.length) {
      r.subDecisions.forEach((d, j) => rows.push({
        ...base, id: `d-${d.id}`, kind: 'approval', Icon: KIND_ICON.approval, detail: d.detail || '',
        decision: { kind: d.kind, id: d.id }, action: actionFor('approval'), order: i + j / 100,
        urgency: urgencyOf({ ...r, detail: d.detail }, now),
      }));
      return;
    }
    const kind = classify(r);
    rows.push({
      ...base, kind, Icon: KIND_ICON[kind] || ArrowRight, detail: r.detail || '',
      id: r.decision ? `d-${r.decision.id}` : r.taskId ? `t-${r.taskId}` : `${base.module}-${i}-${base.title}`,
      decision: r.decision || null, action: actionFor(kind), urgency: urgencyOf(r, now),
    });
  });
  return rows
    .map((r) => ({ ...r, meta: [r.detail, ageLabel(r.stamp, now)].filter(Boolean).join(' · ') }))
    .sort((a, b) => (a.urgency - b.urgency)
      || ((a.stamp && b.stamp) ? (new Date(a.stamp) - new Date(b.stamp)) : 0)
      || (a.order - b.order));
}

// The next thing coming due, for the empty state - the briefing's Updates
// section carries the tasks due in the days ahead when there are any.
export function nextDueOf(data) {
  for (const s of data?.sections || []) {
    if (s.key === 'action_required') continue;
    const hit = (s.rows || []).find((r) => /^Due /i.test(r.detail || ''));
    if (hit) return hit;
  }
  return null;
}

const URGENCY_STATUS = { [OVERDUE]: ['overdue', 'Overdue'], [DUE_TODAY]: ['pending', 'Due Today'] };
const btn = { fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 7, cursor: 'pointer', lineHeight: 1.2, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', flexShrink: 0, whiteSpace: 'nowrap' };
const solid = (tone) => ({ ...btn, background: `hsl(var(--color-${tone}))`, borderColor: `hsl(var(--color-${tone}))`, color: '#fff' });
const textInput = { fontFamily: 'var(--wk-font)', fontSize: 13, width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)' };

export default function MyDay() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [busyId, setBusyId] = useState('');
  const [rejecting, setRejecting] = useState('');     // row id with the reason box open
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);           // { id, message }
  const inFlight = useRef(false);
  const isMobile = useIsMobile();

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    api.getMyBriefing()
      .then((d) => { setData(d || { sections: [] }); setHidden(new Set()); setFailed(false); })
      .catch(() => setFailed(true))
      .finally(() => { inFlight.current = false; });
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    const stop = pollWhileVisible(load, POLL_MS);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const rows = buildMyDayRows(data).filter((r) => !hidden.has(r.id));
  const shown = rows.slice(0, MAX_ROWS);
  const n = rows.length;

  const go = (row) => {
    const t = targetFor(row.path);
    if (t) navigate(t.view, t.sub);
    if (row.taskId) openNotificationTarget({ taskId: row.taskId });
    else if (t?.ticketId) openNotificationTarget({ ticketId: t.ticketId });
  };

  const act = async (row, payload) => {
    setBusyId(row.id); setError(null);
    try {
      await api.actOnMyBriefing(payload);
      setHidden((h) => new Set(h).add(row.id));
      setRejecting(''); setReason('');
      load();
    } catch (e) {
      setError({ id: row.id, message: e?.message || 'That did not go through. Please try again.' });
    } finally { setBusyId(''); }
  };
  const decide = (row, action, text = '') => act(row, { kind: 'decision', id: row.decision.id, decision_kind: row.decision.kind, action, text });
  const complete = (row) => act(row, { kind: 'task', id: row.taskId, action: 'complete', text: '' });
  const openReject = (row) => { setRejecting((cur) => (cur === row.id ? '' : row.id)); setReason(''); setError(null); };

  const target = isMobile ? { minHeight: 44, minWidth: 44, padding: '8px 12px' } : null;
  const sub = !data ? undefined : n === 0 ? 'Nothing waiting on you' : `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`;
  const nextDue = n === 0 ? nextDueOf(data) : null;

  return (
    <DashCard title="My Day" sub={sub}>
      {!data && !failed ? (
        <LoadingState compact />
      ) : failed && !data ? (
        <div role="alert" style={{ ...noteStyle, color: 'hsl(var(--color-red))' }}>Your day could not be loaded right now. It will retry shortly.</div>
      ) : n === 0 ? (
        <div style={noteStyle}>
          You're clear for today.
          {nextDue && <div style={{ marginTop: 6 }}>Next up: {nextDue.title} - {nextDue.detail}</div>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {shown.map((row) => {
            const [status, statusLabel] = URGENCY_STATUS[row.urgency] || [];
            const busy = busyId === row.id;
            return (
              <div key={row.id} data-testid="my-day-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Row Icon={row.Icon} title={row.title} meta={row.meta} status={status} statusLabel={isMobile ? undefined : statusLabel} onClick={() => go(row)} />
                  </div>
                  {row.action.type === 'decision' ? (
                    <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
                      <button type="button" disabled={busy} style={{ ...solid('green'), ...target }} onClick={() => decide(row, 'approve')}>Approve</button>
                      <button type="button" disabled={busy} style={{ ...btn, color: 'hsl(var(--color-red))', ...target }} aria-expanded={rejecting === row.id} onClick={() => openReject(row)}>Reject</button>
                    </span>
                  ) : row.action.type === 'complete' ? (
                    <button type="button" disabled={busy} style={{ ...btn, ...target }} onClick={() => complete(row)}>Complete</button>
                  ) : (
                    <button type="button" style={{ ...btn, ...target }} onClick={() => go(row)}>{row.action.label}</button>
                  )}
                </div>
                {rejecting === row.id && (
                  <div style={{ display: 'grid', gap: 6, padding: '2px 8px 8px 46px' }}>
                    <textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting (required)" style={textInput} aria-label="Reason for rejecting" />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" disabled={busy || !reason.trim()} style={{ ...solid('red'), opacity: reason.trim() ? 1 : 0.5, ...target }} onClick={() => decide(row, 'reject', reason.trim())}>Confirm Reject</button>
                      <button type="button" style={{ ...btn, ...target }} onClick={() => { setRejecting(''); setReason(''); }}>Cancel</button>
                    </div>
                  </div>
                )}
                {error?.id === row.id && (
                  <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 8px 46px', fontSize: 12, fontWeight: 600, color: 'hsl(var(--color-red))' }}>
                    <AlertCircle size={13} /> {error.message}
                  </div>
                )}
              </div>
            );
          })}
          {n > MAX_ROWS && (
            <button type="button" className="secondary-btn" onClick={() => navigate('briefing')}
              style={{ marginTop: 8, alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, ...target }}>
              View All ({n}) <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
    </DashCard>
  );
}
