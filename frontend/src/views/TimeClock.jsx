import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Clock, LogIn, LogOut, Coffee, Play, MapPin, MapPinOff, AlertTriangle,
  CheckCircle, Loader2, Plus, X, CalendarDays, Monitor,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import DayTimeline from '../components/DayTimeline';
import ModuleTabs from '../components/ModuleTabs';
import PayrollTimecard from '../components/PayrollTimecard';
import BodModal from '../components/BodModal';
import { pollWhileVisible } from '../lib/pollWhileVisible';

// ── Time Clock - punch in/out with geofencing (all employees) ─────────────────
// Soft-gate design (research-verified SwipeClock behavior): location is asked
// for AT THE MOMENT of punching only; a denied prompt or coarse fix never
// blocks the punch - it's recorded and flagged for review instead. The button
// set is state-aware ("intelligent clock"): only currently-valid punches show.

// Title Case on titles and buttons (Neil, Jul 28 - supersedes the earlier
// sentence-case rule; see CLAUDE.md).
const KIND_META = {
  in:          { label: 'Punch In',   Icon: LogIn,  bg: 'var(--wk-brand)', fg: '#fff' },
  out:         { label: 'Punch Out',  Icon: LogOut, bg: '#b91c1c',         fg: '#fff' },
  break_start: { label: 'Start Break', Icon: Coffee, bg: '#b45309',        fg: '#fff' },
  break_end:   { label: 'End Break',  Icon: Play,   bg: 'var(--wk-brand)', fg: '#fff' },
};
const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break Start', break_end: 'Break End' };
// Work OS card-header title (sentence case, no uppercase tracking).
const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };
// Small stat label / value inside cards.
const STAT_L = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };

// Timesheet motion (module-scoped, CSS keyframes - reliable regardless of tab focus).
if (typeof document !== 'undefined' && !document.getElementById('ts-anim')) {
  const s = document.createElement('style');
  s.id = 'ts-anim';
  s.textContent = `
    @keyframes tsGrow { from { transform: scaleX(.02); } to { transform: scaleX(1); } }
    @keyframes tsIn   { from { opacity: .2; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes tsPulse{ 0%,100% { opacity: .5; } 50% { opacity: 1; } }
    .ts-block { transform-origin: left; animation: tsGrow .6s cubic-bezier(.22,1,.36,1) forwards; transition: filter .12s ease; }
    .ts-block:hover { filter: brightness(1.08); }
    .ts-day   { animation: tsIn .4s cubic-bezier(.22,1,.36,1) forwards; transition: background .12s ease, box-shadow .12s ease; }
    .ts-day:hover { background: var(--mist); }
    .ts-open  { animation: tsPulse 1.6s ease-in-out infinite; }
    /* Clock tab: ONE shared grid so card edges align across both rows. */
    .tc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; align-items: stretch; }
    .tc-span2 { grid-column: span 2; }
    @media (max-width: 1080px) { .tc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 720px) { .tc-grid { grid-template-columns: 1fr; } .tc-span2 { grid-column: auto; } }
    /* Clocked-in hero: pinging live dot, per-second digit tick, smooth ring sweep. */
    @keyframes tcPing { 0% { box-shadow: 0 0 0 0 var(--ping, rgba(34,150,83,.4)); } 70% { box-shadow: 0 0 0 10px rgba(0,0,0,0); } 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); } }
    @keyframes tcTick { from { transform: translateY(-40%); opacity: 0; } to { transform: none; opacity: 1; } }
    .tc-live { animation: tcPing 1.8s cubic-bezier(.22,1,.36,1) infinite; }
    .tc-tick { animation: tcTick .22s ease-out; }
    @media (prefers-reduced-motion: reduce) { .tc-live, .tc-tick { animation: none; } }`;
  document.head.appendChild(s);
}

// Last-7-calendar-days hours bars (fills from the timesheet data already loaded).
function WeekBars({ days }) {
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000 - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    series.push({ key, label: d.toISOString().slice(0, 10) === key ? d : d, min: days?.[key]?.workedMin || 0, date: d });
  }
  const max = Math.max(60 * 8, ...series.map(s => s.min));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 110 }}>
      {series.map(s => (
        <div key={s.key} title={`${s.key} - ${Math.floor(s.min / 60)}h ${String(s.min % 60).padStart(2, '0')}m`}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: s.min ? 'var(--ink)' : 'transparent', fontVariantNumeric: 'tabular-nums' }}>
            {s.min ? `${(s.min / 60).toFixed(1)}h` : '·'}
          </span>
          <div style={{ width: '70%', maxWidth: 40, height: Math.max(s.min ? 6 : 3, (s.min / max) * 70),
            background: s.min ? 'var(--wk-brand)' : 'var(--mist)', borderRadius: 99 }} />
          <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{s.date.toLocaleDateString([], { weekday: 'short' })}</span>
        </div>
      ))}
    </div>
  );
}

// Bars for a full bi-weekly pay period (one per day, from /my-payroll's day list).
function PeriodBars({ days }) {
  const series = (days || []).map(d => ({ key: d.date, min: d.workedMin || 0, date: new Date(d.date + 'T12:00:00') }));
  const max = Math.max(60 * 8, ...series.map(s => s.min));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>
      {series.map(s => (
        <div key={s.key} title={`${s.key} - ${Math.floor(s.min / 60)}h ${String(s.min % 60).padStart(2, '0')}m`}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <div style={{ width: '78%', maxWidth: 26, height: Math.max(s.min ? 5 : 3, (s.min / max) * 74),
            background: s.min ? 'var(--wk-brand)' : 'var(--mist)', borderRadius: 99 }} />
          <span style={{ fontSize: 8.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.date.getDate()}</span>
        </div>
      ))}
    </div>
  );
}

// Live session timer digits - the seconds pair slides in on each tick (keyed
// remount drives the .tc-tick animation; reduced-motion users get a static swap).
function TimerDigits({ seconds, color, size = 24 }) {
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: size, color, lineHeight: 1 }}>
      {h}:{mm}:<span key={ss} className="tc-tick" style={{ display: 'inline-block' }}>{ss}</span>
    </span>
  );
}

// Session ring - a stopwatch dial: the arc sweeps once per HOUR of the live
// session (Neil, Jul 28: the old fill-toward-8h-day assumed everyone works an
// 8h day - India runs 9h - so the workday denominator is gone entirely).
// Digits inside are the CURRENT session's stopwatch. On break the arc becomes
// the 60m allowance draining (that one is real policy, not an assumption).
function SessionRing({ seconds, pct, color, label, sub }) {
  const size = 148, stroke = 9;
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--mist)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,1,.36,1), stroke .3s ease' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <TimerDigits seconds={seconds} color={color} />
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
        {sub && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{sub}</span>}
      </div>
    </div>
  );
}

const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const TIMEOFF_TYPES = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
const TO_STATUS = { pending: '#b45309', approved: 'hsl(var(--color-green))', rejected: '#b91c1c', cancelled: 'var(--muted)' };
const TO_TINT = { pending: 'rgba(180,83,9,0.1)', approved: 'hsla(var(--color-green),0.1)', rejected: 'rgba(185,28,28,0.08)', cancelled: 'var(--mist)' };

// One-shot position with a hard timeout: never keep the user waiting on GPS.
const getPosition = () => new Promise((resolve) => {
  if (!navigator.geolocation) { resolve(null); return; }
  const done = (v) => { clearTimeout(timer); resolve(v); };
  const timer = setTimeout(() => resolve(null), 9000);
  navigator.geolocation.getCurrentPosition(
    (pos) => done({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude),
                    accuracy_m: Math.round(pos.coords.accuracy || 0) }),
    () => done(null),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
  );
});

function GeoChip({ p }) {
  if (!p) return null;
  if (p.geoStatus === 'in_fence') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}>
      <MapPin size={12} /> at {p.workSiteName || 'site'}
    </span>);
  if (p.geoStatus === 'out_of_fence') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#b45309' }}
      title="Recorded and flagged for review - this never blocks your punch.">
      <AlertTriangle size={12} /> {p.distanceM}m from {p.workSiteName || 'nearest site'} - flagged
    </span>);
  if (p.geoStatus === 'low_accuracy') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}
      title="This device gave only a rough Wi-Fi/IP location (no GPS) - too coarse to judge the geofence. Punch from a phone for a precise fix.">
      <MapPinOff size={12} /> approx. location (±{p.accuracyM >= 1000 ? `${(p.accuracyM / 1000).toFixed(1)}km` : `${p.accuracyM}m`})
    </span>);
  // No location on the punch: show NOTHING (Neil, Jul 28 - the "no location"
  // chip read as an error state when it is the normal desktop case). The
  // punch is still recorded location-less server-side, unchanged.
  return null;
}

export default function TimeClock() {
  const [tab, setTab] = useState('clock');     // clock | timesheet | timeoff
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);        // {ok, text}
  const [bodMode, setBodMode] = useState(null);   // 'bod' | 'eod' | null - day-message modal
  // Disclosed-monitoring consent gate (first in-punch of the day). See doPunch/actualPunch.
  const [monGate, setMonGate] = useState(null);   // { text } | null
  const [monAgree, setMonAgree] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [myReqs, setMyReqs] = useState([]);    // my punch-fix requests + their status
  // Employee's fix requests (add/remove a punch) awaiting approver review. Adds and
  // removes are made inline on the Time Sheet timecard now; this keeps the request
  // stack fresh when one is created (a timeclock-changed event fires on success).
  const loadMyRequests = useCallback(() => { api.timeMyPunchRequests().then(setMyReqs).catch(() => {}); }, []);
  // Decided requests (approved/rejected) can be dismissed once the employee has
  // seen them; pending ones stay until decided. Dismissals persist per-browser.
  const [dismissedReqs, setDismissedReqs] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('nx-timereq-dismissed') || '[]')); } catch { return new Set(); }
  });
  const dismissReq = (id) => setDismissedReqs(prev => {
    const n = new Set(prev); n.add(id);
    try { localStorage.setItem('nx-timereq-dismissed', JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });
  const [, setTick] = useState(0);             // re-render for the live timer
  useEffect(() => { loadMyRequests(); }, [loadMyRequests]);
  const msgTimer = useRef(null);

  const toast = (ok, text) => {
    setMsg({ ok, text });
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 6000);
  };

  const load = useCallback(() => {
    api.timeStatus().then(setStatus).catch(e => toast(false, e?.message || 'Could not load your time clock.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000); // live stopwatch
    return () => clearInterval(t);
  }, []);
  // Cross-device sync: punch state lives on the server, so a break/punch on ANY
  // of your devices must show up here without a manual refresh. Re-fetch on a
  // short poll, and - for the common "I just switched to this device" case -
  // instantly when the tab regains focus/visibility. Same-device punches fire
  // nexus:timeclock-changed locally.
  useEffect(() => {
    const stopPoll = pollWhileVisible(load, 20000);
    const onVis = () => { if (document.visibilityState === 'visible') { load(); loadMyRequests(); } };
    const onChange = () => { load(); loadMyRequests(); };   // a self add/remove request just fired
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('nexus:timeclock-changed', onChange);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('nexus:timeclock-changed', onChange);
    };
  }, [load]);

  const [timeoff, setTimeoff] = useState(null);
  const [toForm, setToForm] = useState({ type: 'vacation', start: '', end: '', note: '' });
  const [toBusy, setToBusy] = useState(false);
  useEffect(() => { api.timeOffMine().then(setTimeoff).catch(() => setTimeoff([])); }, []);

  async function submitTimeoff() {
    if (toBusy) return;
    if (!toForm.start || !toForm.end) { toast(false, 'Pick the start and end dates.'); return; }
    setToBusy(true);
    try {
      await api.timeOffCreate({ type: toForm.type, start_date: toForm.start, end_date: toForm.end, note: toForm.note });
      toast(true, 'Time-off request sent - your manager gets a notification.');
      setToForm({ type: 'vacation', start: '', end: '', note: '' });
      api.timeOffMine().then(setTimeoff).catch(() => {});
    } catch (e) { toast(false, e?.message || 'Could not send the request.'); }
    setToBusy(false);
  }

  async function doPunch(kind) {
    if (busy) return;
    // Login/break prompts come FIRST - the punch happens only after the message
    // is sent or explicitly acknowledged (see BodModal's ack-to-skip).
    // Every punch prompts for its message; the "already sent" checkbox lets a
    // repeat punch skip. (BOD gates punch-in, EOD gates checkout, break gates.)
    if (kind === 'in') { setBodMode('bod-gate'); return; }
    if (kind === 'break_start') { setBodMode('break-gate'); return; }
    if (kind === 'out') { setBodMode('eod-gate'); return; }
    await actualPunch(kind);
  }

  // Record a "already sent elsewhere" marker so the prompt doesn't nag again today.
  function bodMarker(kind) {
    return api.timeBodRecord({ kind, message: '(sent outside Nexus)', sent: false,
      tz_offset_min: new Date().getTimezoneOffset() }).catch(() => {});
  }

  // ── Disclosed-monitoring consent gate ───────────────────────────────────────
  // On company-owned devices the first in-punch of the day must acknowledge
  // today's monitoring notice before it's recorded. Open the gate, and on
  // confirm record consent then retry the punch once (consented=true).
  function openMonGate(detail) {
    const m = status?.monitoring || {};
    setMonAgree(false);
    setMonGate({ text: detail?.text || m.text || '' });
  }
  async function confirmMonitoring() {
    if (monBusy) return;
    setMonBusy(true);
    try {
      await api.timeMonitoringConsent();
      setStatus(s => (s?.monitoring ? { ...s, monitoring: { ...s.monitoring, consentRequired: false } } : s));
      setMonGate(null);
      setMonBusy(false);
      actualPunch('in', true);
    } catch (e) {
      toast(false, e?.message || 'Could not record your acknowledgment.');
      setMonBusy(false);
    }
  }

  async function actualPunch(kind, consented = false) {
    if (busy) return;
    // First in-punch of the day: gate on the monitoring notice if consent is owed.
    if (kind === 'in' && !consented && status?.monitoring?.consentRequired) {
      openMonGate();
      return;
    }
    setBusy(kind);
    const pos = await getPosition();
    try {
      const r = await api.timePunch({
        kind, ...(pos || {}), tz_offset_min: new Date().getTimezoneOffset(),
      });
      const p = r.punch;
      const where = p.geoStatus === 'in_fence' ? ` at ${p.workSiteName}`
        : p.geoStatus === 'out_of_fence' ? ` - ${p.distanceM}m from ${p.workSiteName || 'the nearest site'}, flagged for review`
        : p.geoStatus === 'low_accuracy' ? ' - location too approximate to judge (no GPS on this device)'
        : pos ? '' : ' - location unavailable, recorded without it';
      toast(true, `${KIND_META[kind].label} at ${localTime(p.at)}${where}.`);
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); // sync the global mini-timer
      load();
    } catch (e) {
      // The backend can also gate the in-punch with a 409 - show the notice,
      // then retry once after the employee acknowledges (openMonGate → confirm).
      const needsConsent = e?.detail?.code === 'monitoring_consent_required'
        || /monitoring_consent_required/i.test(e?.message || '');
      if (kind === 'in' && !consented && needsConsent) {
        openMonGate(e?.detail);
        setBusy('');
        return;
      }
      toast(false, e?.message || 'Punch failed.');
    }
    setBusy('');
  }

  const last = status?.lastPunch;
  const clockedIn = last && last.kind !== 'out';
  const onBreak = last && last.kind === 'break_start';
  const sinceSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;
  const days = status?.days || {};

  // Long-session guard (Jul 27): the current session's in-punch, so we can tell
  // someone clocked in 12+ hours "still working, or forgot to punch out?" -
  // last.at alone isn't the session start when the newest punch is a break.
  const [longAckAt, setLongAckAt] = useState(() => Number(localStorage.getItem('nexus:longShiftAck') || 0));
  let sessionInAt = null;
  if (clockedIn) {
    Object.values(days).forEach(d => (d.punches || []).forEach(p => {
      if (p.kind === 'in' && !p.voided && (!sessionInAt || p.at > sessionInAt)) sessionInAt = p.at;
    }));
    if (!sessionInAt && last?.kind === 'in') sessionInAt = last.at;
  }
  const sessionHours = sessionInAt ? (Date.now() - new Date(sessionInAt + 'Z').getTime()) / 3600000 : 0;
  const showLongBanner = clockedIn && sessionHours >= 12 && (Date.now() - longAckAt) > 4 * 3600000;


  const todayKey = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todayData = days[todayKey];
  const weekTotal = Object.values(days).reduce((a, d) => a + d.workedMin, 0);
  // Daily break allowance: 1 hour. Used = completed breaks today + the live open one.
  const BREAK_ALLOWANCE_MIN = 60;
  const breakUsedMin = (todayData?.breakMin || 0) + (onBreak ? Math.floor(sinceSec / 60) : 0);
  const breakLeftMin = BREAK_ALLOWANCE_MIN - breakUsedMin;

  // ── Current pay period (the Clock tab's mini summary). The Time Sheet tab is the
  //    PayrollTimecard, which loads and paginates periods on its own. ────────────
  const [clockPeriod, setClockPeriod] = useState(null);
  useEffect(() => {
    if (tab !== 'clock') return;
    api.timeMyPayroll('').then(setClockPeriod).catch(() => setClockPeriod(null));
  }, [tab]);
  const fmtShort = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <div style={{ fontFamily: 'var(--wk-font)', animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Standard module header band (view-header carries the hairline divider
          that separates every module's title from its content). */}
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Clock size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ margin: 0 }}>Time Clock</h2>
            <p style={{ margin: '2px 0 0' }}>Punch in and out, your timesheet and time off</p>
          </div>
        </div>
      </div>

      {/* Tabs - one job per screen (the everything-in-one page read as clutter).
          Desktop renders them centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both). */}
      <ModuleTabs
        tabs={[
          { key: 'clock',     label: 'Clock' },
          { key: 'timesheet', label: 'Time Sheet' },
          { key: 'timeoff',   label: 'Time Off' },
        ]}
        active={tab} onChange={setTab} />

      {msg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: msg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: msg.ok ? 'hsl(var(--color-green))' : '#b91c1c', fontSize: 13, fontWeight: 600 }}>
          {msg.ok ? <CheckCircle size={15} /> : <AlertTriangle size={15} />} {msg.text}
        </div>
      )}

      {/* Punch card + today panel, side by side on wide screens */}
      {tab === 'clock' && (<>
      {showLongBanner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'rgba(180,83,9,0.09)', border: '1.5px solid rgba(180,83,9,0.4)' }}>
          <AlertTriangle size={17} style={{ color: '#b45309', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#b45309', flex: 1, minWidth: 220 }}>
            You've been clocked in for {Math.floor(sessionHours)} hours - still working, or did you forget to punch out?
          </span>
          <button className="secondary-btn" style={{ fontSize: 12 }}
            onClick={() => { const t = Date.now(); localStorage.setItem('nexus:longShiftAck', String(t)); setLongAckAt(t); }}>
            I'm still working
          </button>
          <button className="primary-btn" style={{ fontSize: 12 }}
            onClick={() => {
              // The fix lives inline on the Time Sheet: click the red "Missing" out-cell
              // to send an approver-confirmed clock-out request.
              setTab('timesheet');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}>
            I forgot - fix my punch-out
          </button>
        </div>
      )}
      <div className="tc-grid" style={{ marginBottom: 18 }}>
      <div className="tc-span2" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--wk-shadow)', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {!status ? (
          <SkeletonBlocks count={2} height={20} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
            {clockedIn && (
              /* Working: stopwatch dial, one sweep per hour of this session.
                 On break: arc = the 60m allowance draining (red once over). */
              <SessionRing seconds={sinceSec}
                pct={onBreak ? breakUsedMin / BREAK_ALLOWANCE_MIN : (sinceSec % 3600) / 3600}
                color={onBreak ? (breakLeftMin < 0 ? '#b91c1c' : '#b45309') : 'var(--wk-brand)'}
                label={onBreak ? 'On Break' : 'This Session'}
                sub={onBreak ? (breakLeftMin >= 0 ? `${breakLeftMin}m of 60m left` : `${-breakLeftMin}m over 60m`) : undefined} />
            )}
            <div style={{ flex: 1, minWidth: 250, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
              <span className={clockedIn ? 'tc-live' : ''} style={{ width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
                background: onBreak ? '#b45309' : clockedIn ? 'var(--wk-brand)' : 'var(--wk-faint)',
                '--ping': onBreak ? 'rgba(180,83,9,.4)' : 'rgba(43,69,225,.4)' }} />
              <span style={{ fontSize: 25, fontWeight: 700, color: onBreak ? '#b45309' : clockedIn ? 'var(--wk-brand)' : 'var(--ink)' }}>
                {onBreak ? 'On Break' : clockedIn ? 'Clocked In' : 'Clocked Out'}
              </span>
              {last && (
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  since {localTime(last.at)}
                </span>
              )}
            </div>
            {last && <div><GeoChip p={last} /></div>}
            {onBreak && (
              <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 10,
                background: breakLeftMin < 0 ? 'hsla(var(--color-red),0.1)' : 'rgba(180,83,9,0.09)',
                color: breakLeftMin < 0 ? 'hsl(var(--color-red))' : '#b45309', fontSize: 13, fontWeight: 700 }}>
                <Coffee size={14} />
                {breakLeftMin >= 0
                  ? `${breakLeftMin} min left of your 1h daily break`
                  : `Break over by ${-breakLeftMin} min - over your 1h daily allowance`}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 3 }}>
              {(status.allowed || []).map(kind => {
                const M = KIND_META[kind];
                return (
                  <button key={kind} onClick={async () => {
                      // Screen-share is required to clock in / come back from break
                      // (except for monitoring-exempt staff). The browser only grants
                      // sharing on a user gesture, so start it from within this click
                      // and WAIT: if the person dismisses the picker, block the punch.
                      // start() resolves true when a stream is live or capture isn't
                      // required here - so a false means "required but declined".
                      if (kind === 'in' || kind === 'break_end') {
                        const ok = await (window.__nexusCapture?.start?.() ?? Promise.resolve(true));
                        if (!ok) {
                          toast(false, kind === 'in'
                            ? 'You need to share a screen to clock in. Choose a screen when your browser asks, then tap again.'
                            : 'You need to share a screen to end your break. Choose a screen when your browser asks, then tap again.');
                          return;
                        }
                      }
                      doPunch(kind);
                    }} disabled={!!busy}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '14px 26px', borderRadius: 12,
                      border: 'none', cursor: busy ? 'default' : 'pointer', fontFamily: 'var(--wk-font)',
                      fontSize: 15, fontWeight: 700, background: M.bg, color: M.fg, opacity: busy && busy !== kind ? 0.55 : 1 }}>
                    {busy === kind ? <Loader2 size={17} style={{ animation: 'spin 1s linear infinite' }} /> : <M.Icon size={17} />}
                    {busy === kind ? 'Getting location…' : M.label}
                  </button>
                );
              })}
            </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--wk-shadow)', minWidth: 0 }}>
        <div style={{ ...HD, marginBottom: 12 }}>Today</div>
        {todayData ? (
          <>
            <DayTimeline punches={todayData.punches} date={todayKey} />
            <div style={{ display: 'flex', gap: 26, marginTop: 18, flexWrap: 'wrap' }}>
              {[['Worked Today', fmtMin(todayData.workedMin), 'var(--ink)'],
                ['Breaks', `${breakUsedMin} / 60m`, breakUsedMin > 60 ? 'hsl(var(--color-red))' : 'var(--ink)'],
                ['Last 7 Days', fmtMin(weekTotal), 'var(--ink)']].map(([l, v, c]) => (
                <div key={l}>
                  <div style={STAT_L}>{l}</div>
                  <div style={{ fontSize: 19, fontWeight: 700, color: c, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                </div>
              ))}
            </div>
            {todayData.flags.length > 0 && (
              <button onClick={() => setTab('timesheet')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 12, fontSize: 11, fontWeight: 700,
                  color: '#b45309', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
                <AlertTriangle size={11} /> {todayData.flags.length} item{todayData.flags.length === 1 ? '' : 's'} for review - see Time Sheet
              </button>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            No punches yet today.{weekTotal > 0 ? ` You've worked ${fmtMin(weekTotal)} in the last 7 days.` : ''}
          </div>
        )}
      </div>
      {/* Jul 24: the standing location/monitoring notice paragraphs were removed by
          management decision - capture is initiated by the employee's own share
          action (with the browser's persistent sharing indicator), and standing
          disclosure lives in the signed monitoring policy. The consent-gate modal
          below stays as dormant code (the server no longer requests it). */}

        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--wk-shadow)', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
            <span style={HD}>This Pay Period</span>
            {clockPeriod?.periodStart && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {fmtShort(clockPeriod.periodStart)} – {fmtShort(clockPeriod.periodEnd)}
              </span>
            )}
          </div>
          {clockPeriod ? (<>
            {(clockPeriod.totals?.workedMin || 0) > 0 ? <PeriodBars days={clockPeriod.days} /> : (
              <div style={{ height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '0 12px' }}>
                No hours yet this period - your days chart here as you punch in.
              </div>
            )}
            {(() => {
              const t = clockPeriod.totals || {};
              const activeDays = (clockPeriod.days || []).filter(d => (d.workedMin || 0) > 0).length;
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12 }}>
                  <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Total {fmtMin(t.workedMin || 0)}</span>
                  <span style={{ color: 'var(--muted)' }}>{activeDays} day{activeDays !== 1 ? 's' : ''} worked · {t.breakMin || 0}m breaks</span>
                </div>
              );
            })()}
            <button className="secondary-btn" style={{ fontSize: 11, padding: '4px 11px', marginTop: 12, alignSelf: 'flex-start' }} onClick={() => setTab('timesheet')}>
              Open Time Sheet
            </button>
          </>) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 110, color: 'var(--muted)' }}>
              <WeekBars days={days} />
            </div>
          )}
        </div>

        {/* This week - hours vs the 40h OT line, today's break allowance, est. pay
            and pending fix requests. Everything derives from data already loaded. */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--wk-shadow)', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={HD}>This Week</div>
          {(() => {
            const sun = new Date(); sun.setHours(0, 0, 0, 0); sun.setDate(sun.getDate() - sun.getDay());
            const sunKey = new Date(sun.getTime() - sun.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
            const wkMin = clockPeriod
              ? (clockPeriod.days || []).filter(d => d.date >= sunKey).reduce((a, d) => a + (d.workedMin || 0), 0)
              : weekTotal;
            const otMin = Math.max(0, wkMin - 40 * 60);
            const pct = Math.min(100, (wkMin / (40 * 60)) * 100);
            const bPct = Math.min(100, (breakUsedMin / BREAK_ALLOWANCE_MIN) * 100);
            const PTc = clockPeriod?.totals || {};
            const curSym = (clockPeriod?.currency || PTc.currency) === 'INR' ? '₹' : '$';
            const pendingReqs = myReqs.filter(r => r.status === 'pending').length;
            return (<>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
                  <span style={STAT_L}>Hours Worked</span>
                  <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMin(wkMin)} <span style={{ color: 'var(--muted)', fontWeight: 500 }}>of 40h</span></span>
                </div>
                <div style={{ height: 8, borderRadius: 99, background: 'var(--mist)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: otMin ? '#dc7a18' : 'var(--wk-brand)' }} />
                </div>
                {otMin > 0 && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#b45309', marginTop: 5 }}>{fmtMin(otMin)} into overtime (1.5×)</div>}
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
                  <span style={STAT_L}>Break Today</span>
                  <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{breakUsedMin}m <span style={{ color: 'var(--muted)', fontWeight: 500 }}>of 60m</span></span>
                </div>
                <div style={{ height: 8, borderRadius: 99, background: 'var(--mist)', overflow: 'hidden' }}>
                  <div style={{ width: `${bPct}%`, height: '100%', borderRadius: 99, background: breakUsedMin > BREAK_ALLOWANCE_MIN ? '#b91c1c' : '#248f4b' }} />
                </div>
              </div>
              {clockPeriod?.rateSet && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  <span style={STAT_L}>Est. Pay This Period</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--wk-brand)', fontVariantNumeric: 'tabular-nums' }}>{curSym}{(PTc.totalPay || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              {pendingReqs > 0 && (
                <button onClick={() => setTab('timesheet')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(180,83,9,0.08)', border: 'none', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 600, color: '#b45309', textAlign: 'left' }}>
                  <AlertTriangle size={12} /> {pendingReqs} punch-fix request{pendingReqs === 1 ? '' : 's'} awaiting your approver
                </button>
              )}
            </>);
          })()}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--wk-shadow)', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ ...HD, flex: 1 }}>Time Off Coming Up</span>
            <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 11px' }} onClick={() => setTab('timeoff')}>Request</button>
          </div>
          {(() => {
            const upcoming = (timeoff || []).filter(r => r.status !== 'rejected' && r.status !== 'cancelled' && (r.endDate || '') >= todayKey).slice(0, 4);
            return upcoming.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Nothing booked - your approved leave shows here.</div>
            ) : upcoming.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
                <CalendarDays size={13} style={{ color: 'var(--wk-brand)', flexShrink: 0 }} />
                <span style={{ fontWeight: 700, textTransform: 'capitalize' }}>{r.type}</span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{r.startDate} → {r.endDate}</span>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', padding: '2px 9px', borderRadius: 999,
                  background: r.status === 'approved' ? 'hsla(var(--color-green),0.1)' : 'rgba(180,83,9,0.1)',
                  color: r.status === 'approved' ? 'hsl(var(--color-green))' : '#b45309' }}>{r.status}</span>
              </div>
            ));
          })()}
        </div>
      </div>
      </>)}

      {/* Timesheet - day list + week summary side panel */}
      {tab === 'timesheet' && (<>
      {/* One employee time view - the SAME payroll timecard HR sees, scoped to me.
          Editing an In/Out time or adding a missing punch here creates an
          approver-confirmed request; nothing moves on my pay until it's approved.

          My pending/decided punch requests sit above it: add/remove requests don't
          appear in the grid until approved, so this is the only place they show.
          Decided ones can be dismissed once seen; pending ones stay until decided. */}
      {(() => {
        const visible = myReqs.filter(r => r.status === 'pending' || !dismissedReqs.has(r.id));
        if (!visible.length) return null;
        return (
        <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visible.slice(0, 8).map(r => {
            const c = r.status === 'approved' ? 'hsl(var(--color-green))'
              : r.status === 'rejected' ? 'hsl(var(--color-red))' : '#b45309';
            const tint = r.status === 'approved' ? 'hsla(var(--color-green),0.1)'
              : r.status === 'rejected' ? 'rgba(185,28,28,0.08)' : 'rgba(180,83,9,0.1)';
            const when = r.action === 'add' && r.at ? ` at ${localTime(r.at)}` : '';
            const decided = r.status !== 'pending';
            return (
              /* Status is a PILL and free-text (your reason, the approver's note)
                 is QUOTED with a label - bare dot-separated fragments read as
                 buttons/errors ("· Reject" looked like a dead action). */
              <div key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', fontSize: 12.5, padding: '8px 12px', background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'capitalize', color: c, background: tint, padding: '2px 10px', borderRadius: 999, flexShrink: 0 }}>{r.status}</span>
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{r.action === 'add' ? `Add ${(KIND_LABEL[r.punchKind] || r.punchKind).toLowerCase()}${when}` : 'Remove a punch'}</span>
                {r.reason && <span style={{ color: 'var(--muted)' }}>Your reason: “{r.reason}”</span>}
                {r.status === 'rejected' && r.decisionNote && <span style={{ color: 'hsl(var(--color-red))' }}>Approver: “{r.decisionNote}”</span>}
                <span style={{ flex: 1, minWidth: 8 }} />
                {decided
                  ? <button onClick={() => dismissReq(r.id)} title="Dismiss" aria-label="Dismiss this request"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: 2, flexShrink: 0 }}><X size={14} /></button>
                  : <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', flexShrink: 0 }}>waiting for approver</span>}
              </div>
            );
          })}
        </div>
        );
      })()}

      <PayrollTimecard selfMode toastOk={t => toast(true, t)} toastErr={t => toast(false, t)} />
      </>)}


      {/* Time off */}
      {tab === 'timeoff' && (<>
      <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, boxShadow: 'var(--wk-shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
          <span className="wkc-chip"><CalendarDays size={14} /></span>
          <span style={HD}>Request Time Off</span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-input" value={toForm.type} onChange={e => setToForm(f => ({ ...f, type: e.target.value }))}
            style={{ width: 140, fontSize: 12.5 }}>
            {Object.entries(TIMEOFF_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="form-input" type="date" value={toForm.start} onChange={e => setToForm(f => ({ ...f, start: e.target.value }))} style={{ fontSize: 12.5, width: 150 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
          <input className="form-input" type="date" value={toForm.end} onChange={e => setToForm(f => ({ ...f, end: e.target.value }))} style={{ fontSize: 12.5, width: 150 }} />
          <input className="form-input" placeholder="Note (optional)" value={toForm.note}
            onChange={e => setToForm(f => ({ ...f, note: e.target.value }))} style={{ flex: 1, minWidth: 160, fontSize: 12.5 }} />
          <button className="primary-btn" onClick={submitTimeoff} disabled={toBusy} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {toBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={13} />} Request
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1.7 1 440px', background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, overflow: 'hidden', marginBottom: 24, boxShadow: 'var(--wk-shadow)' }}>
        {(timeoff || []).length === 0 && (
          <div style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
            No time-off requests yet.
          </div>
        )}
        {(timeoff || []).map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, width: 90 }}>{TIMEOFF_TYPES[r.type] || r.type}</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.startDate} → {r.endDate}</span>
            {r.note && <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{r.note}”</span>}
            <div style={{ flex: 1 }} />
            {r.decideNote && <span style={{ fontSize: 11, color: 'var(--muted)' }} title={r.decideNote}>💬</span>}
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', padding: '2px 10px', borderRadius: 999,
              background: TO_TINT[r.status] || 'var(--mist)', color: TO_STATUS[r.status] || 'var(--muted)' }}>
              {r.status}
            </span>
          </div>
        ))}
      </div>

      {/* Year-at-a-glance side panel */}
      <div style={{ flex: '1 1 280px', background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '18px 20px', boxShadow: 'var(--wk-shadow)' }}>
        <div style={{ ...HD, marginBottom: 12 }}>
          {new Date().getFullYear()} at a Glance
        </div>
        {(() => {
          const yr = String(new Date().getFullYear());
          const dayCount = (r) => {
            const a = new Date(r.startDate), b = new Date(r.endDate);
            return isNaN(a) || isNaN(b) ? 0 : Math.round((b - a) / 86400000) + 1;
          };
          const approved = (timeoff || []).filter(r => r.status === 'approved' && (r.startDate || '').startsWith(yr));
          const byType = {};
          approved.forEach(r => { byType[r.type] = (byType[r.type] || 0) + dayCount(r); });
          const totalDays = Object.values(byType).reduce((a, b) => a + b, 0);
          const pending = (timeoff || []).filter(r => r.status === 'pending').length;
          return (
            <>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--wk-brand)', fontVariantNumeric: 'tabular-nums' }}>{totalDays}<span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}> day{totalDays !== 1 ? 's' : ''} approved</span></div>
              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                {Object.keys(byType).length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No approved leave this year yet.</div>}
                {Object.entries(byType).map(([t, n]) => (
                  <div key={t} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span style={{ textTransform: 'capitalize', color: 'var(--muted)', fontWeight: 600 }}>{TIMEOFF_TYPES[t] || t}</span>
                    <span style={{ fontWeight: 800 }}>{n}d</span>
                  </div>
                ))}
              </div>
              {pending > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: '#b45309' }}>{pending} request{pending !== 1 ? 's' : ''} awaiting approval</div>
              )}
              <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                Requests go to your manager; you'll get a bell notification when they decide.
              </p>
            </>
          );
        })()}
      </div>
      </div>
      </>)}

      {bodMode && (() => {
        const modalMode = bodMode === 'bod-gate' ? 'bod'
          : bodMode === 'break-gate' ? 'break'
          : bodMode === 'eod-gate' ? 'eod' : bodMode;
        // All gates hold the punch until the message is sent OR explicitly
        // acknowledged (ack-to-skip). Closing the modal cancels the punch.
        const proceed = bodMode === 'bod-gate' ? () => { setBodMode(null); actualPunch('in'); }
          : bodMode === 'break-gate' ? () => { setBodMode(null); actualPunch('break_start'); }
          : bodMode === 'eod-gate' ? () => { setBodMode(null); actualPunch('out'); }
          : () => setBodMode(null);
        const onSkip = bodMode === 'bod-gate' ? () => { bodMarker('bod'); proceed(); }
          : bodMode === 'eod-gate' ? () => { bodMarker('eod'); proceed(); }
          : proceed;
        return <BodModal mode={modalMode} required onSent={proceed} onSkip={onSkip}
          onClose={() => setBodMode(null)}
          toastOk={t => toast(true, t)} toastErr={t => toast(false, t)} />;
      })()}

      {/* Disclosed-monitoring consent gate - real notice the employee reads and
          acknowledges before the first in-punch is recorded. */}
      {monGate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1440, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 540, maxHeight: 'min(90dvh, 680px)', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
            <div style={{ padding: '15px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="wkc-chip"><Monitor size={14} /></span>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Before you clock in</h3>
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>Please read and acknowledge how this device is monitored.</p>
              </div>
              <button onClick={() => setMonGate(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ padding: '16px 22px', overflowY: 'auto', fontSize: 13, color: 'var(--ink)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
              {monGate.text || 'This is a company-owned device. While you are clocked in, Nexus records your worked time and may capture periodic screenshots of your work screen, the apps and windows you have open, and your overall activity level. This is used only to verify work time and activity - it never captures your keystrokes, and it stops the moment you clock out.'}
            </div>
            <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
                <input type="checkbox" checked={monAgree} onChange={e => setMonAgree(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--wk-brand)' }} />
                I understand and agree
              </label>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="secondary-btn" onClick={() => setMonGate(null)}>Cancel</button>
                <button className="primary-btn" onClick={confirmMonitoring} disabled={!monAgree || monBusy}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {monBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Acknowledge &amp; clock in
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
