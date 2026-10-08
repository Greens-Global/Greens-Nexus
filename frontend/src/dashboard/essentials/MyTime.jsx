// My Time (Essentials, Oct 8) - "Am I clocked in, are my hours right, when do
// I work next?" for everyone, registered as 'my-time' in widgets.jsx and loaded
// as its own lazy chunk.
//
// Reads: /timeclock/status (state, the last 7 days, exceptions, the exempt
// flag), /timeclock/my-schedule (published shifts, approved time off, company
// holidays), /timeclock/my-payroll (this pay period's total and my own
// timesheet-review state) and /timesheet-review/waiting (time cards submitted
// to me as a manager). The status call polls every 60s while the tab is
// visible; the slower three every 5 minutes, plus after every punch.
//
// Punching reuses the global mini-timer's quick flow (components/
// TimeclockWidget.jsx): Punch Out / Start Break / End Break go through
// punchDurable with a geolocation fix, land the parked punch first, and offer
// the end-of-day message after a punch-out. Punch In is NOT done here - the
// Time Clock screen owns the beginning-of-day gate, the monitoring consent,
// the shared-PC agent pairing and the full geofence budget, so the button
// hands off there exactly like the Time Clock tile does.
import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, LogOut, Coffee, Play, CalendarDays, AlertTriangle, ArrowRight, Palmtree } from 'lucide-react';

import { api } from '../../api';
import { LoadingState } from '../../components/AsyncState';
import BodModal from '../../components/BodModal';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { punchDurable, replayPending, readPending } from '../../lib/punchQueue';
import { punchPosition } from '../../lib/geoPosition';
import { useIsMobile } from '../../lib/useIsMobile';
import { formatDate, formatTime, formatHHMM, formatWeekday } from '../../lib/datetime';
import { DashCard, navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';

const DAY_MS = 86400000;
const STATUS_POLL_MS = 60000;
const EXTRAS_POLL_MS = 5 * 60000;
const TIME_OFF_LOOKAHEAD_DAYS = 14;
const SHIFT_LOOKAHEAD_DAYS = 21;

export const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
// Local calendar date as YYYY-MM-DD - the key the time clock's `days` map uses.
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server timestamps in the time clock are UTC without a zone marker.
const utc = (s) => new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
const dateOf = (key) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || ''); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const TIMEOFF_TYPES = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Time Off' };
const PUNCH_LABEL = { in: 'Punch In', out: 'Punch Out', break_start: 'Start Break', break_end: 'End Break' };
// Day flags from _day_summaries that mean a punch is missing or wrong.
const EXCEPTION_FLAGS = { missing_out: 'Missing clock-out', out_without_in: 'Clock-out without a clock-in', missing_break_end: 'Missing break end', auto_clock_out: 'Unconfirmed auto clock-out' };

// "Thu 10/09" - today and tomorrow say so instead.
export function dayLabel(d, now) {
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `${formatWeekday(d, 'short')} ${formatDate(d).slice(0, 5)}`;
}

// Walk every punch the status payload carries (last 7 days) and return the
// open shift, if any: when it was clocked in and the minutes worked so far
// (breaks excluded, an open break frozen). Null when nothing is open.
function openSession(days, last, now) {
  const all = Object.values(days).flatMap(d => d?.punches || []).filter(p => p?.at && p.kind).sort((a, b) => a.at.localeCompare(b.at));
  if (!all.length) {
    // Older payload shape: elapsed from the last punch, paused on a break.
    if (!last?.at) return null;
    const inAt = utc(last.at);
    return { inAt, workedMin: last.kind === 'break_start' ? 0 : Math.max(0, Math.floor((now - inAt) / 60000)) };
  }
  let inAt = null, breakMs = 0, openBreak = null;
  for (const p of all) {
    if (p.kind === 'in') { inAt = utc(p.at); breakMs = 0; openBreak = null; }
    else if (p.kind === 'out') { inAt = null; breakMs = 0; openBreak = null; }
    else if (inAt && p.kind === 'break_start') openBreak = utc(p.at);
    else if (inAt && p.kind === 'break_end' && openBreak) { breakMs += utc(p.at) - openBreak; openBreak = null; }
  }
  if (!inAt) return null;
  const live = (now - inAt) - breakMs - (openBreak ? now - openBreak : 0);
  return { inAt, workedMin: Math.max(0, Math.floor(live / 60000)) };
}

/**
 * The pure view model: everything the tile shows, from the four payloads.
 * Any of them may be null (not loaded / failed) - a missing one hides its
 * section, never throws.
 */
export function deriveMyTime({ status, schedule, card, waiting, now = new Date() }) {
  const exempt = !!status?.timeTrackingExempt;
  const last = status?.lastPunch;
  const stale = !!status?.staleOpenShift;
  const clockedIn = !exempt && !!(last && last.kind !== 'out') && !stale;
  const onBreak = clockedIn && last?.kind === 'break_start';
  const state = exempt ? 'exempt' : !status ? 'unknown' : onBreak ? 'break' : clockedIn ? 'in' : 'out';
  const stateLabel = { exempt: 'Time Tracking Not Required', unknown: '', break: 'On Break', in: 'Clocked In', out: 'Clocked Out' }[state];
  // The open shift: its clock-in (what "since" names) and the minutes worked
  // so far. A day's workedMin counts only CLOSED segments, so the live one is
  // rebuilt from the day's punches - clock-in to now, less every break.
  // Without punches in the payload, fall back to the last punch like the
  // Time Clock tile does.
  const session = clockedIn ? openSession(status?.days || {}, last, now) : null;
  const since = session?.inAt || (clockedIn && last?.at ? utc(last.at) : null);
  const sinceLabel = since ? `since ${formatTime(since)}` : '';
  // What the clock accepts next - the server's state machine, same list the
  // Time Clock screen and the mini-timer read.
  const allowed = exempt || !status ? [] : (Array.isArray(status.allowed) && status.allowed.length ? status.allowed : (clockedIn ? (onBreak ? ['break_end', 'out'] : ['out', 'break_start']) : ['in']));
  const actions = allowed.filter(k => PUNCH_LABEL[k]).map(k => ({ kind: k, label: PUNCH_LABEL[k], primary: k === 'in' || k === 'out' }));

  // Hours: today's closed segments plus the live session (paused on break),
  // this week from the week start, and the pay period from the timecard.
  const elapsedMin = session ? session.workedMin : 0;
  const days = status?.days || {};
  const todayKey = localKey(now);
  const todayMin = (days[todayKey]?.workedMin || 0) + elapsedMin;
  const weekStartsMonday = (schedule?.weekStart || 'sunday') === 'monday';
  const dow = now.getDay();
  const back = weekStartsMonday ? (dow + 6) % 7 : dow;
  let weekMin = elapsedMin;
  for (let i = 0; i <= back; i++) weekMin += days[localKey(new Date(now.getTime() - i * DAY_MS))]?.workedMin || 0;
  const t = card?.totals;
  const period = card?.periodStart && t
    ? { min: (Number(t.regMin) || 0) + (Number(t.otMin) || 0) + (Number(t.dtMin) || 0) + elapsedMin, start: card.periodStart, end: card.periodEnd || '' }
    : null;
  const hours = { todayMin, weekMin, period };

  // Next shift: the first published shift still ahead (today's counts until
  // it ends); without one, the next weekday of the default preset.
  let nextShift = null;
  if (schedule) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const rows = (schedule.scheduled || [])
      .filter(s => s?.date && (s.date > todayKey || (s.date === todayKey && (hhmmToMin(s.end) ?? 1e9) > nowMin)))
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.start || '').localeCompare(String(b.start || '')));
    if (rows.length) {
      const s = rows[0];
      nextShift = { date: s.date, start: s.start, end: s.end, label: s.label || '', fromPreset: false };
    } else if (schedule.shift?.start && schedule.shift?.days) {
      const want = new Set(String(schedule.shift.days).split(',').map(x => Number(x.trim())).filter(Boolean));
      const endMin = hhmmToMin(schedule.shift.end);
      for (let i = 0; i <= 7 && !nextShift; i++) {
        const d = addDays(now, i);
        const iso = ((d.getDay() + 6) % 7) + 1;   // ISO weekday, Mon=1
        if (!want.has(iso)) continue;
        if (i === 0 && endMin != null && endMin <= nowMin) continue;
        nextShift = { date: localKey(d), start: schedule.shift.start, end: schedule.shift.end, label: schedule.shift.name || '', fromPreset: true };
      }
    }
  }
  if (nextShift) {
    const d = dateOf(nextShift.date) || now;
    nextShift.when = `${dayLabel(d, now)}, ${formatHHMM(nextShift.start, nextShift.start)} to ${formatHHMM(nextShift.end, nextShift.end)}`;
  }

  // Approved time off and company holidays in the next 14 days.
  const timeOff = [];
  if (schedule) {
    const horizon = localKey(addDays(now, TIME_OFF_LOOKAHEAD_DAYS));
    for (const r of schedule.timeoff || []) {
      if (r.status !== 'approved' || !r.startDate) continue;
      const end = r.endDate || r.startDate;
      if (end < todayKey || r.startDate > horizon) continue;
      const range = end !== r.startDate ? `${formatDate(dateOf(r.startDate))} - ${formatDate(dateOf(end))}` : dayLabel(dateOf(r.startDate), now);
      timeOff.push({ id: `to-${r.id}`, title: TIMEOFF_TYPES[r.type] || r.type || 'Time Off', meta: range, sort: r.startDate, kind: 'timeoff' });
    }
    for (const h of schedule.holidays || []) {
      if (!h?.date || h.date < todayKey || h.date > horizon) continue;
      timeOff.push({ id: `h-${h.date}-${h.name}`, title: h.name || 'Holiday', meta: `${h.type === 'optional' ? 'Optional holiday' : 'Company holiday'} · ${dayLabel(dateOf(h.date), now)}`, sort: h.date, kind: 'holiday' });
    }
    timeOff.sort((a, b) => a.sort.localeCompare(b.sort));
  }

  // The amber line(s): missing punches, my time card's review state, and time
  // cards waiting on me as a reviewer.
  const alerts = [];
  if (!exempt && status) {
    if (stale) {
      alerts.push({ id: 'stale', text: `A shift from ${formatDate(utc(status.staleOpenSince || last?.at))} was never clocked out.`, action: { label: 'Fix a Punch', view: 'timeclock', sub: 'timesheet' } });
    }
    // The live session is flagged missing_out on its own day until it closes
    // - that is not an exception, so skip that day while clocked in.
    const openDay = clockedIn ? (last?.localDate || localKey(since || now)) : null;
    const exceptionDays = Object.keys(days).filter(k => (days[k]?.flags || []).some(f => EXCEPTION_FLAGS[f] && !(k === openDay && f === 'missing_out'))).sort();
    if (exceptionDays.length) {
      const first = exceptionDays[0];
      const flag = (days[first].flags || []).find(f => EXCEPTION_FLAGS[f]);
      const more = exceptionDays.length > 1 ? ` and ${exceptionDays.length - 1} more day${exceptionDays.length > 2 ? 's' : ''}` : '';
      alerts.push({ id: 'exception', text: `${EXCEPTION_FLAGS[flag]} on ${formatDate(dateOf(first))}${more}.`, action: { label: 'Fix a Punch', view: 'timeclock', sub: 'timesheet' } });
    }
    const rv = card?.review;
    if (rv?.status === 'signing' && (rv.turn === 'employee' || rv.myPartyId)) {
      alerts.push({ id: 'sign', text: 'Your time card is ready for your signature.', action: { label: 'Sign Time Card', view: 'timeclock', sub: 'timesheet' } });
    } else if (rv?.status === 'with_manager') {
      alerts.push({ id: 'with-manager', text: 'Your time card is with your manager for review.', action: { label: 'View Time Card', view: 'timeclock', sub: 'timesheet' } });
    } else if (rv?.status === 'with_employee' && (rv.rounds || []).length) {
      alerts.push({ id: 'sent-back', text: 'Your manager sent your time card back for changes.', action: { label: 'Review Time Card', view: 'timeclock', sub: 'timesheet' } });
    }
  }
  const queue = Array.isArray(waiting?.reviews) ? waiting.reviews.length : 0;
  if (queue) {
    alerts.push({ id: 'queue', text: `${queue} time card${queue === 1 ? '' : 's'} waiting for your review.`, action: { label: 'Review Time Cards', view: 'timeclock', sub: 'timesheet' } });
  }

  return { exempt, state, stateLabel, since, sinceLabel, actions, hours, nextShift, timeOff, alerts };
}

const ACTION_ICON = { in: Play, out: LogOut, break_start: Coffee, break_end: Play };
const amberStyle = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'hsl(var(--color-orange) / .10)', color: 'var(--ink)', fontSize: 12.5, lineHeight: 1.4 };
const sectionLabel = { fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 };
const linkBtn = { border: 'none', background: 'none', padding: 0, color: 'var(--wk-brand, hsl(var(--color-blue)))', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' };

export default function MyTime() {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState(null);         // null = pending; { error: true } = failed with nothing to show
  const [extras, setExtras] = useState({ schedule: null, card: null, waiting: null });
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [eodOpen, setEodOpen] = useState(false);
  const alive = useRef(true);

  const loadStatus = useCallback(() => api.timeStatus()
    .then(s => { if (alive.current) setStatus(s || {}); })
    .catch(() => { if (alive.current) setStatus(s => s || { error: true }); }), []);
  const loadExtras = useCallback(() => {
    const today = new Date();
    const start = localKey(today), end = localKey(addDays(today, SHIFT_LOOKAHEAD_DAYS));
    return Promise.all([
      api.timeMySchedule(start, end).catch(() => null),
      api.timeMyPayroll().catch(() => null),
      api.timesheetReviewWaiting().catch(() => null),
    ]).then(([schedule, card, waiting]) => { if (alive.current) setExtras({ schedule, card, waiting }); });
  }, []);
  const loadAll = useCallback(() => { loadStatus(); loadExtras(); }, [loadStatus, loadExtras]);

  useEffect(() => {
    alive.current = true;
    loadAll();
    const stopStatus = pollWhileVisible(loadStatus, STATUS_POLL_MS);
    const stopExtras = pollWhileVisible(loadExtras, EXTRAS_POLL_MS);
    // A punch made on the Time Clock screen or from the floating pill.
    window.addEventListener('nexus:timeclock-changed', loadStatus);
    return () => { alive.current = false; stopStatus(); stopExtras(); window.removeEventListener('nexus:timeclock-changed', loadStatus); };
  }, [loadAll, loadStatus, loadExtras]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const vm = deriveMyTime({ status: status?.error ? null : status, schedule: extras.schedule, card: extras.card, waiting: extras.waiting, now });

  // The mini-timer's quick flow (components/TimeclockWidget.jsx quickBreak /
  // quickPunchOut): land a parked punch first, then a durable punch with a
  // location fix. Punch In hands off to the Time Clock screen (see header).
  async function act(kind) {
    if (kind === 'in') { navigate('timeclock', 'overview'); return; }
    if (busy) return;
    setBusy(kind); setErr('');
    try {
      const held = readPending();
      if (held) {
        const r = await replayPending();
        if (!r?.restored && !r?.dropped) {
          setErr('An earlier punch has not recorded yet. Open Time Clock to retry it before punching again.');
          return;
        }
      }
      const pos = await punchPosition(kind);
      const res = await punchDurable({ kind, tzOffsetMin: new Date().getTimezoneOffset(), pos });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        if (kind === 'out' && res.result?.promptEod) setEodOpen(true);
        loadAll();
      } else if (res.unreachable) {
        setErr(res.queued
          ? 'Nexus could not reach the server. Your punch is saved on this device and will record when the connection returns.'
          : 'Nexus could not reach the server and the punch did not record. Open Time Clock to retry.');
      } else {
        setErr(res.error?.message || 'Punch failed.');
      }
    } finally {
      if (alive.current) setBusy('');
    }
  }

  const btnBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: isMobile ? 44 : 32, padding: isMobile ? '0 14px' : '0 12px', fontSize: 12.5, flex: isMobile ? 1 : undefined };
  const stateColor = vm.state === 'break' ? 'hsl(var(--color-orange))' : vm.state === 'in' ? 'hsl(var(--color-green))' : 'var(--muted)';
  const showHours = !vm.exempt || vm.hours.todayMin > 0 || vm.hours.weekMin > 0;
  const subtitle = status && !status.error && !vm.exempt ? (vm.sinceLabel ? `${vm.stateLabel} ${vm.sinceLabel}` : vm.stateLabel) : undefined;

  return (
    <DashCard title="My Time" sub={subtitle} action={<Clock size={15} style={{ color: 'var(--muted)' }} />}>
      {!status ? (
        <LoadingState compact />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
          {status.error && (
            <div style={{ ...amberStyle, background: 'hsl(var(--color-red) / .08)' }}>
              <AlertTriangle size={14} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1 }}>Could not load your time right now. <button type="button" style={linkBtn} onClick={loadAll}>Try Again</button></span>
            </div>
          )}

          {/* (1) Status + punch controls */}
          {vm.exempt ? (
            <div style={{ ...noteStyle, padding: '6px 0', textAlign: 'left' }}>Time tracking is not required for your role.</div>
          ) : !status.error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: stateColor }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: stateColor }} />
                {vm.stateLabel}{vm.sinceLabel && <span style={{ fontWeight: 500, color: 'var(--muted)' }}>{vm.sinceLabel}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {vm.actions.map(a => {
                  const I = ACTION_ICON[a.kind] || Clock;
                  return (
                    <button key={a.kind} type="button" className={a.primary ? 'primary-btn' : 'secondary-btn'} style={btnBase}
                      disabled={!!busy} aria-busy={busy === a.kind || undefined} onClick={() => act(a.kind)}>
                      <I size={13} /> {busy === a.kind ? 'Recording…' : a.label}
                    </button>
                  );
                })}
              </div>
              {err && <div role="alert" style={{ fontSize: 12, color: 'hsl(var(--color-red))', lineHeight: 1.4 }}>{err}</div>}
            </div>
          )}

          {/* (2) Hours */}
          {showHours && (
            <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.1, color: 'var(--wk-ink, var(--ink))', fontVariantNumeric: 'tabular-nums' }}>{fmtH(vm.hours.todayMin)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Today</div>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtH(vm.hours.weekMin)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>This Week</div>
              </div>
              {vm.hours.period && (
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtH(vm.hours.period.min)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }} title={`${formatDate(dateOf(vm.hours.period.start))}${vm.hours.period.end ? ` - ${formatDate(dateOf(vm.hours.period.end))}` : ''}`}>Pay Period</div>
                </div>
              )}
            </div>
          )}

          {/* (3) Next shift + upcoming time off / holidays */}
          {(vm.nextShift || vm.timeOff.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {vm.nextShift && (
                <div>
                  <div style={sectionLabel}>Next Shift</div>
                  <button type="button" className="dash-link-row" onClick={() => navigate('timeclock', 'overview')}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'var(--ink)', fontSize: 13, fontWeight: 600, minHeight: isMobile ? 44 : undefined }}>
                    <CalendarDays size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span>{vm.nextShift.when}{vm.nextShift.label ? <span style={{ fontWeight: 500, color: 'var(--muted)' }}> · {vm.nextShift.label}</span> : null}</span>
                  </button>
                </div>
              )}
              {vm.timeOff.length > 0 && (
                <div>
                  <div style={sectionLabel}>Coming Up</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {vm.timeOff.slice(0, 3).map(r => (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                        {r.kind === 'holiday' ? <CalendarDays size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <Palmtree size={14} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />}
                        <span style={{ fontWeight: 600 }}>{r.title}</span>
                        <span style={{ color: 'var(--muted)' }}>{r.meta}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* (4) Amber lines */}
          {vm.alerts.map(a => (
            <div key={a.id} style={amberStyle}>
              <AlertTriangle size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1 }}>{a.text}</span>
              {a.action && (
                <button type="button" style={{ ...linkBtn, whiteSpace: 'nowrap', minHeight: isMobile ? 44 : undefined }} onClick={() => navigate(a.action.view, a.action.sub)}>
                  {a.action.label} <ArrowRight size={12} />
                </button>
              )}
            </div>
          ))}

          {/* (5) Footer */}
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" style={btnBase} onClick={() => navigate('timeclock', 'timeoff')}>
              Request Time Off <ArrowRight size={13} />
            </button>
            {!vm.exempt && (
              <button type="button" style={{ ...linkBtn, minHeight: isMobile ? 44 : undefined }} onClick={() => navigate('timeclock', 'overview')}>Open Time Clock</button>
            )}
          </div>
        </div>
      )}
      {eodOpen && <BodModal mode="eod" onClose={() => setEodOpen(false)} toastOk={() => {}} toastErr={() => {}} />}
    </DashCard>
  );
}
