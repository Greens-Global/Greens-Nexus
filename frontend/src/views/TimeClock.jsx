import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Clock, LogIn, LogOut, Coffee, Play, MapPin, MapPinOff, AlertTriangle,
  CheckCircle, Loader2, Plus, X, CalendarDays, Monitor, ChevronDown,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { api } from '../api';
import DayTimeline from '../components/DayTimeline';
import BodModal from '../components/BodModal';

const PUNCH_CHIP = {
  in:          { bg: 'hsla(var(--color-green),0.1)', fg: 'hsl(var(--color-green))' },
  out:         { bg: 'rgba(185,28,28,0.07)',         fg: '#b91c1c' },
  break_start: { bg: 'rgba(245,158,11,0.12)',        fg: '#b45309' },
  break_end:   { bg: 'rgba(245,158,11,0.12)',        fg: '#b45309' },
};

// ── Time Clock — punch in/out with geofencing (all employees) ─────────────────
// Soft-gate design (research-verified SwipeClock behavior): location is asked
// for AT THE MOMENT of punching only; a denied prompt or coarse fix never
// blocks the punch — it's recorded and flagged for review instead. The button
// set is state-aware ("intelligent clock"): only currently-valid punches show.

const KIND_META = {
  in:          { label: 'Punch in',   Icon: LogIn,  bg: 'var(--pine)', fg: '#fff' },
  out:         { label: 'Punch out',  Icon: LogOut, bg: '#b91c1c',     fg: '#fff' },
  break_start: { label: 'Start break', Icon: Coffee, bg: '#b45309',    fg: '#fff' },
  break_end:   { label: 'End break',  Icon: Play,   bg: 'var(--pine)', fg: '#fff' },
};
const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break start', break_end: 'Break end' };
const CARD_S = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12 };

// Timesheet motion (module-scoped, CSS keyframes — reliable regardless of tab focus).
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
    .ts-open  { animation: tsPulse 1.6s ease-in-out infinite; }`;
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
        <div key={s.key} title={`${s.key} — ${Math.floor(s.min / 60)}h ${String(s.min % 60).padStart(2, '0')}m`}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: s.min ? 'var(--pine)' : 'transparent' }}>
            {s.min ? `${(s.min / 60).toFixed(1)}h` : '·'}
          </span>
          <div style={{ width: '70%', maxWidth: 40, height: Math.max(s.min ? 5 : 2, (s.min / max) * 70),
            background: s.min ? 'var(--pine)' : 'var(--mist)', borderRadius: '5px 5px 2px 2px', opacity: 0.9 }} />
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
        <div key={s.key} title={`${s.key} — ${Math.floor(s.min / 60)}h ${String(s.min % 60).padStart(2, '0')}m`}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <div style={{ width: '78%', maxWidth: 26, height: Math.max(s.min ? 4 : 2, (s.min / max) * 74),
            background: s.min ? 'var(--pine)' : 'var(--mist)', borderRadius: '4px 4px 2px 2px', opacity: 0.9 }} />
          <span style={{ fontSize: 8.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.date.getDate()}</span>
        </div>
      ))}
    </div>
  );
}

const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const fmtHMS = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
const TIMEOFF_TYPES = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
const TO_STATUS = { pending: '#b45309', approved: 'hsl(var(--color-green))', rejected: '#b91c1c', cancelled: 'var(--muted)' };

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
      title="Recorded and flagged for review — this never blocks your punch.">
      <AlertTriangle size={12} /> {p.distanceM}m from {p.workSiteName || 'nearest site'} — flagged
    </span>);
  if (p.geoStatus === 'low_accuracy') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}
      title="This device gave only a rough Wi-Fi/IP location (no GPS) — too coarse to judge the geofence. Punch from a phone for a precise fix.">
      <MapPinOff size={12} /> approx. location (±{p.accuracyM >= 1000 ? `${(p.accuracyM / 1000).toFixed(1)}km` : `${p.accuracyM}m`})
    </span>);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>
      <MapPinOff size={12} /> no location
    </span>);
}

export default function TimeClock() {
  const [tab, setTab] = useState('clock');     // clock | timesheet | timeoff
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);        // {ok, text}
  const [missedOpen, setMissedOpen] = useState(false);
  const [openDays, setOpenDays] = useState({});   // expanded timesheet days
  const [bodMode, setBodMode] = useState(null);   // 'bod' | 'eod' | null — day-message modal
  // Disclosed-monitoring consent gate (first in-punch of the day). See doPunch/actualPunch.
  const [monGate, setMonGate] = useState(null);   // { text } | null
  const [monAgree, setMonAgree] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [missed, setMissed] = useState({ kind: 'out', at: '', note: '' });
  const [myReqs, setMyReqs] = useState([]);    // my punch-fix requests + their status
  const [, setTick] = useState(0);             // re-render for the live timer
  useEffect(() => { api.timeMyPunchRequests().then(setMyReqs).catch(() => {}); }, []);
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
      toast(true, 'Time-off request sent — your manager gets a notification.');
      setToForm({ type: 'vacation', start: '', end: '', note: '' });
      api.timeOffMine().then(setTimeoff).catch(() => {});
    } catch (e) { toast(false, e?.message || 'Could not send the request.'); }
    setToBusy(false);
  }

  async function doPunch(kind) {
    if (busy) return;
    // Login/break prompts come FIRST — the punch happens only after the message
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
        : p.geoStatus === 'out_of_fence' ? ` — ${p.distanceM}m from ${p.workSiteName || 'the nearest site'}, flagged for review`
        : p.geoStatus === 'low_accuracy' ? ' — location too approximate to judge (no GPS on this device)'
        : pos ? '' : ' — location unavailable, recorded without it';
      toast(true, `${KIND_META[kind].label} at ${localTime(p.at)}${where}.`);
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); // sync the global mini-timer
      load();
    } catch (e) {
      // The backend can also gate the in-punch with a 409 — show the notice,
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

  // Employee's fix requests (add/remove a punch) awaiting approver review.
  function loadMyRequests() { api.timeMyPunchRequests().then(setMyReqs).catch(() => {}); }

  async function submitMissed() {
    if (!missed.at || !missed.note.trim()) { toast(false, 'Pick the time and add a reason.'); return; }
    try {
      const utc = new Date(missed.at).toISOString().slice(0, 19);
      // Goes to your approver — nothing changes on the timesheet until they approve.
      await api.timePunchRequestCreate({ action: 'add', punch_kind: missed.kind, at: utc,
        tz_offset_min: new Date().getTimezoneOffset(), reason: missed.note.trim() });
      toast(true, "Request sent to your approver — you'll be notified when it's reviewed.");
      setMissedOpen(false); setMissed({ kind: 'out', at: '', note: '' });
      loadMyRequests();
    } catch (e) { toast(false, e?.message || 'Could not send the request.'); }
  }

  // Open the "Missed a punch?" form pre-filled to ADD the missing clock-out for a
  // given segment — so the fix is one click from where the gap is shown, instead
  // of hunting for the form and re-entering the kind/day by hand.
  function openAddClockOut(seg) {
    // seg.in is a UTC timestamp (no Z); seed the day/time in LOCAL for the picker.
    let at = '';
    if (seg?.in) {
      const d = new Date(seg.in + 'Z');
      at = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    setMissed({ kind: 'out', at, note: '' });
    setMissedOpen(true);
    // Bring the form (top of the tab) into view.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function requestRemovePunch(p) {
    const reason = window.prompt('Why should this punch be removed? (sent to your approver)');
    if (reason === null) return;
    if (!reason.trim()) { toast(false, 'A reason is required.'); return; }
    try {
      await api.timePunchRequestCreate({ action: 'remove', target_punch_id: p.id, reason: reason.trim() });
      toast(true, "Removal request sent to your approver.");
      loadMyRequests();
    } catch (e) { toast(false, e?.message || 'Could not send the request.'); }
  }

  const last = status?.lastPunch;
  const clockedIn = last && last.kind !== 'out';
  const onBreak = last && last.kind === 'break_start';
  const sinceSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;
  const days = status?.days || {};
  const dayKeys = Object.keys(days).sort().reverse();

  // Timesheet range filter — 7 days come with /status; longer ranges fetch on demand.
  const [tsRange, setTsRange] = useState(7);
  const [rangeDays, setRangeDays] = useState(null);
  useEffect(() => {
    if (tsRange === 7) { setRangeDays(null); return; }
    const off = new Date().getTimezoneOffset() * 60000;
    const end = new Date(Date.now() - off).toISOString().slice(0, 10);
    const start = new Date(Date.now() - off - (tsRange - 1) * 86400000).toISOString().slice(0, 10);
    api.timeMy(start, end).then(r => setRangeDays(r.days || {})).catch(() => setRangeDays({}));
  }, [tsRange]);
  const tsDays = tsRange === 7 ? days : (rangeDays || {});
  const tsKeys = Object.keys(tsDays).sort().reverse();
  const tsTotal = Object.values(tsDays).reduce((a, d) => a + d.workedMin, 0);
  const tsBreak = Object.values(tsDays).reduce((a, d) => a + d.breakMin, 0);
  const tsFlags = Object.values(tsDays).reduce((a, d) => a + d.flags.length, 0);

  const todayKey = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todayData = days[todayKey];
  const weekTotal = Object.values(days).reduce((a, d) => a + d.workedMin, 0);
  const weekBreak = Object.values(days).reduce((a, d) => a + d.breakMin, 0);
  // Daily break allowance: 1 hour. Used = completed breaks today + the live open one.
  const BREAK_ALLOWANCE_MIN = 60;
  const breakUsedMin = (todayData?.breakMin || 0) + (onBreak ? Math.floor(sinceSec / 60) : 0);
  const breakLeftMin = BREAK_ALLOWANCE_MIN - breakUsedMin;
  const weekFlags = Object.values(days).reduce((a, d) => a + d.flags.length, 0);

  // ── Bi-weekly pay period (the timesheet's data) ──────────────────────────────
  const [payStart, setPayStart] = useState('');   // '' = current period; else a Sunday start
  const [payData, setPayData]   = useState(null);
  const [payLoading, setPayLoading] = useState(false);
  const [payErr, setPayErr]     = useState('');
  const [payKey, setPayKey]     = useState(0);   // bump to retry
  const [openDay, setOpenDay]   = useState(null);
  useEffect(() => {
    if (tab !== 'timesheet') return;
    setPayLoading(true); setPayErr('');
    api.timeMyPayroll(payStart)
      .then(d => { setPayData(d); setPayErr(''); })
      .catch(e => { setPayData(null); setPayErr(e?.message || 'Could not load your timesheet. Please try again.'); })
      .finally(() => setPayLoading(false));
  }, [tab, payStart, payKey]);
  // Clock tab shows the CURRENT pay period (independent of any timesheet nav).
  const [clockPeriod, setClockPeriod] = useState(null);
  useEffect(() => {
    if (tab !== 'clock') return;
    api.timeMyPayroll('').then(setClockPeriod).catch(() => setClockPeriod(null));
  }, [tab]);
  function shiftPeriod(dir) {
    const base = payData?.periodStart || todayKey;
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + dir * 14);
    setPayStart(d.toISOString().slice(0, 10));
    setOpenDay(null);
  }
  const isCurrentPeriod = !payData || (payData.periodStart <= todayKey && todayKey <= payData.periodEnd);
  const payDayMap = Object.fromEntries((payData?.days || []).map(d => [d.date, d]));
  const payGrid = [];
  if (payData?.periodStart) {
    const s = new Date(payData.periodStart + 'T12:00:00');
    for (let i = 0; i < (payData.periodDays || 14); i++) {
      const dt = new Date(s); dt.setDate(s.getDate() + i);
      payGrid.push(dt.toISOString().slice(0, 10));
    }
  }
  const PT = payData?.totals || {};
  const compActive = PT.activeMin || 0, compIdle = PT.idleMin || 0, compBreak = PT.breakMin || 0;
  const compTotal = Math.max(1, compActive + compIdle + compBreak);
  const fmtDay = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtShort = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  const COMP = [['Active', compActive, 'var(--pine)'], ['Idle', compIdle, '#b45309'], ['Break', compBreak, 'hsl(var(--color-blue))']];
  const GRID_COLS = '1.4fr 1fr 1fr 0.8fr 1fr 22px';

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto', padding: '26px 22px', fontFamily: 'Inter,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Clock size={20} style={{ color: 'var(--pine)' }} />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Time Clock</h1>
      </div>

      {/* Tabs — one job per screen (the everything-in-one page read as clutter) */}
      <div className="chip-row scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {[['clock', 'Clock'], ['timesheet', 'Time Sheet'], ['timeoff', 'Time Off']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ padding: '7px 16px', borderRadius: 10, border: `1px solid ${tab === key ? 'var(--pine)' : 'var(--line)'}`,
              background: tab === key ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
              color: tab === key ? 'hsl(var(--color-green))' : 'var(--muted)',
              fontWeight: tab === key ? 700 : 600, fontSize: 13, cursor: 'pointer', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {label}
          </button>
        ))}
      </div>

      {msg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: msg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: msg.ok ? 'hsl(var(--color-green))' : '#b91c1c', fontSize: 13, fontWeight: 600 }}>
          {msg.ok ? <CheckCircle size={15} /> : <AlertTriangle size={15} />} {msg.text}
        </div>
      )}

      {/* Punch card + today panel, side by side on wide screens */}
      {tab === 'clock' && (<>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 18 }}>
      <div style={{ flex: '1.3 1 420px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '26px 28px', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
        {!status ? (
          <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>
            <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: onBreak ? '#b45309' : clockedIn ? 'var(--pine)' : 'var(--ink)' }}>
                {onBreak ? 'On break' : clockedIn ? 'Clocked in' : 'Clocked out'}
              </span>
              {last && clockedIn && (
                <span style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: onBreak ? '#b45309' : 'var(--pine)' }}>
                  {fmtHMS(sinceSec)}
                </span>
              )}
              {last && (
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  since {localTime(last.at)}
                </span>
              )}
            </div>
            {last && <div style={{ marginBottom: onBreak ? 10 : 16 }}><GeoChip p={last} /></div>}
            {onBreak && (
              <div style={{ marginBottom: 16, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 10,
                background: breakLeftMin < 0 ? 'hsla(var(--color-red),0.1)' : 'rgba(180,83,9,0.09)',
                color: breakLeftMin < 0 ? 'hsl(var(--color-red))' : '#b45309', fontSize: 13, fontWeight: 700 }}>
                <Coffee size={14} />
                {breakLeftMin >= 0
                  ? `${breakLeftMin} min left of your 1h daily break`
                  : `Break over by ${-breakLeftMin} min — over your 1h daily allowance`}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {(status.allowed || []).map(kind => {
                const M = KIND_META[kind];
                return (
                  <button key={kind} onClick={() => {
                      // Start screen capture from within the punch-in / end-break
                      // click — the browser only grants screen sharing on a user
                      // gesture, so it can't auto-start after the punch resolves.
                      // No-op if the monitoring policy is off or a stream is still
                      // running (the usual case: the stream survives the break and
                      // capture just un-pauses). Only re-acquires — with a picker —
                      // when the stream was torn down during the break.
                      if (kind === 'in' || kind === 'break_end') window.__nexusCapture?.start?.();
                      doPunch(kind);
                    }} disabled={!!busy}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '14px 26px', borderRadius: 12,
                      border: 'none', cursor: busy ? 'default' : 'pointer', fontFamily: 'Inter,sans-serif',
                      fontSize: 15, fontWeight: 800, background: M.bg, color: M.fg, opacity: busy && busy !== kind ? 0.55 : 1 }}>
                    {busy === kind ? <Loader2 size={17} style={{ animation: 'spin 1s linear infinite' }} /> : <M.Icon size={17} />}
                    {busy === kind ? 'Getting location…' : M.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: '1 1 320px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '22px 24px' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>Today</div>
        {todayData ? (
          <>
            <DayTimeline punches={todayData.punches} date={todayKey} />
            <div style={{ display: 'flex', gap: 26, marginTop: 18, flexWrap: 'wrap' }}>
              {[['Worked today', fmtMin(todayData.workedMin), 'var(--pine)'],
                ['Breaks', `${breakUsedMin} / 60m`, breakUsedMin > 60 ? 'hsl(var(--color-red))' : 'var(--ink)'],
                ['Last 7 days', fmtMin(weekTotal), 'var(--ink)']].map(([l, v, c]) => (
                <div key={l}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>{l}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
            {todayData.flags.length > 0 && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 12, fontSize: 11, fontWeight: 700, color: '#b45309' }}>
                <AlertTriangle size={11} /> {todayData.flags.length} item{todayData.flags.length === 1 ? '' : 's'} for review — see Time Sheet
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            No punches yet today.{weekTotal > 0 ? ` You've worked ${fmtMin(weekTotal)} in the last 7 days.` : ''}
          </div>
        )}
      </div>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--muted)' }}>
        Your location is captured only at the moment you punch, to confirm you're at a work site.
        If location is off or you're away from a site, the punch still counts — it's simply flagged for review.
      </p>
      {/* Disclosed-monitoring: standing notice on the clock page (full text is acknowledged at the first in-punch). */}
      {status?.monitoring?.enabled && (
        <p style={{ margin: '-8px 0 18px', fontSize: 12, color: 'var(--muted)' }}>
          On this company-owned device, while you're clocked in Nexus may capture periodic screenshots,
          the apps you have open, and your overall activity level — to verify work time only, never your
          keystrokes, and it stops when you clock out. You acknowledge the full notice the first time you clock in each day.
        </p>
      )}

      {/* Fill the fold: week chart, today's screen activity, upcoming time off */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>This pay period</span>
            {clockPeriod?.periodStart && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {fmtShort(clockPeriod.periodStart)} – {fmtShort(clockPeriod.periodEnd)}
              </span>
            )}
          </div>
          {clockPeriod ? (<>
            <PeriodBars days={clockPeriod.days} />
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
            <button className="secondary-btn" style={{ fontSize: 11, padding: '4px 11px', marginTop: 12 }} onClick={() => setTab('timesheet')}>
              Open timesheet
            </button>
          </>) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 110, color: 'var(--muted)' }}>
              <WeekBars days={days} />
            </div>
          )}
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Time off coming up</span>
            <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 11px' }} onClick={() => setTab('timeoff')}>Request</button>
          </div>
          {(() => {
            const upcoming = (timeoff || []).filter(r => r.status !== 'rejected' && r.status !== 'cancelled' && (r.endDate || '') >= todayKey).slice(0, 4);
            return upcoming.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Nothing booked — your approved leave shows here.</div>
            ) : upcoming.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
                <CalendarDays size={13} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                <span style={{ fontWeight: 700, textTransform: 'capitalize' }}>{r.type}</span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{r.startDate} → {r.endDate}</span>
                <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: r.status === 'approved' ? 'var(--pine)' : '#b45309' }}>{r.status}</span>
              </div>
            ));
          })()}
        </div>
      </div>
      </>)}

      {/* Timesheet — day list + week summary side panel */}
      {tab === 'timesheet' && (<>
      {/* Pay-period header + navigation (California bi-weekly) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={() => shiftPeriod(-1)} title="Previous pay period" style={{ padding: '7px 9px', display: 'inline-flex' }}><ChevronLeft size={16} /></button>
        <div style={{ minWidth: 190 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>
            {payData ? `${fmtShort(payData.periodStart)} – ${fmtShort(payData.periodEnd)}` : payErr ? 'Unavailable' : 'Loading…'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Bi-weekly pay period{isCurrentPeriod ? ' · current' : ''}</div>
        </div>
        <button className="secondary-btn" onClick={() => shiftPeriod(1)} disabled={isCurrentPeriod} title="Next pay period"
          style={{ padding: '7px 9px', display: 'inline-flex', opacity: isCurrentPeriod ? 0.4 : 1, cursor: isCurrentPeriod ? 'default' : 'pointer' }}><ChevronRight size={16} /></button>
        <div style={{ flex: 1 }} />
        <button className="secondary-btn" onClick={() => setMissedOpen(o => !o)}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {missedOpen ? <X size={12} /> : <Plus size={12} />} {missedOpen ? 'Cancel' : 'Missed a punch?'}
        </button>
      </div>

      {missedOpen && (
        <div style={{ background: 'var(--card)', border: '1.5px dashed var(--line)', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="form-input" value={missed.kind} onChange={e => setMissed(m => ({ ...m, kind: e.target.value }))}
              style={{ width: 150, fontSize: 12.5 }}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input className="form-input" type="datetime-local" value={missed.at}
              onChange={e => setMissed(m => ({ ...m, at: e.target.value }))} style={{ fontSize: 12.5 }} />
            <input className="form-input" placeholder="Why was it missed? (required)" value={missed.note}
              onChange={e => setMissed(m => ({ ...m, note: e.target.value }))} style={{ flex: 1, minWidth: 200, fontSize: 12.5 }} />
            <button className="primary-btn" onClick={submitMissed} style={{ fontSize: 12.5 }}>Send Request</button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)' }}>
            This goes to your approver — nothing changes on your timesheet until they approve it.
          </p>
        </div>
      )}

      {/* My pending/decided fix requests, so the employee can track them. */}
      {myReqs.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {myReqs.slice(0, 6).map(r => {
            const c = r.status === 'approved' ? 'hsl(var(--color-green))'
              : r.status === 'rejected' ? 'hsl(var(--color-red))' : '#b45309';
            const when = r.action === 'add' && r.at ? ` at ${localTime(r.at)}` : '';
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, padding: '7px 12px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10 }}>
                <span style={{ fontWeight: 700, textTransform: 'capitalize', color: c, minWidth: 64 }}>{r.status}</span>
                <span style={{ color: 'var(--ink)' }}>{r.action === 'add' ? `Add ${KIND_LABEL[r.punchKind] || r.punchKind}${when}` : 'Remove a punch'}</span>
                {r.reason && <span style={{ color: 'var(--muted)' }}>· {r.reason}</span>}
                {r.status === 'rejected' && r.decisionNote && <span style={{ color: 'hsl(var(--color-red))' }}>· {r.decisionNote}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Summary — one composition bar (worked/idle/break) + payroll totals */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: '2 1 380px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 14 }}>How this period breaks down</div>
          <div style={{ display: 'flex', height: 22, borderRadius: 8, overflow: 'hidden', background: 'var(--mist)' }}>
            {COMP.map(([l, v, c]) => v > 0 ? <div key={l} title={`${l}: ${fmtMin(v)}`} style={{ width: `${(v / compTotal) * 100}%`, background: c }} /> : null)}
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            {COMP.map(([l, v, c]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: c, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{l}</span>
                <span style={{ fontWeight: 800 }}>{fmtMin(v)}</span>
              </div>
            ))}
          </div>
          {compIdle === 0 && <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted)' }}>Idle is measured only while screen capture is running.</p>}
        </div>
        <div style={{ flex: '1 1 230px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>Payroll</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {[['Regular', fmtMin(PT.regMin || 0), 'var(--ink)'],
              ['Overtime', fmtMin(PT.otMin || 0), PT.otMin ? '#b45309' : 'var(--muted)'],
              ...(PT.dtMin ? [['Double time', fmtMin(PT.dtMin), '#b91c1c']] : []),
              ['Total worked', fmtMin(PT.workedMin || 0), 'var(--pine)']].map(([l, v, c]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{l}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: c }}>{v}</span>
              </div>
            ))}
            {payData?.rateSet && (
              <div style={{ borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Est. pay</span>
                <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--pine)' }}>${(PT.totalPay || 0).toFixed(2)}</span>
              </div>
            )}
          </div>
          {PT.missingPunches > 0 && <p style={{ margin: '10px 0 0', fontSize: 11, color: '#b45309', fontWeight: 600 }}>{PT.missingPunches} day{PT.missingPunches !== 1 ? 's' : ''} missing a clock-out — fix before payday.</p>}
        </div>
      </div>

      {/* Pay-period days — a visual timeline per worked day (segments shown inline) */}
      {payErr && !payData ? (
        <div style={{ ...CARD_S, padding: '30px 20px', textAlign: 'center' }}>
          <AlertTriangle size={20} style={{ color: '#b45309', marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600, marginBottom: 4 }}>Couldn’t load your timesheet</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{payErr}</div>
          <button className="primary-btn" onClick={() => setPayKey(k => k + 1)} disabled={payLoading} style={{ fontSize: 12.5 }}>
            {payLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Try again'}
          </button>
        </div>
      ) : payLoading && !payData ? (
        <div style={{ padding: 40, textAlign: 'center' }}><Loader2 size={18} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(() => {
            const msOf = (iso) => iso ? new Date(iso + 'Z').getTime() : 0;
            return payGrid.map(ds => {
              const d = payDayMap[ds];
              const segs = d?.segments || [];
              // Off day — a quiet line so worked days stand out.
              if (!d || segs.length === 0) return (
                <div key={ds} style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', fontSize: 12, color: 'var(--muted)' }}>
                  <span style={{ width: 100, fontWeight: 600 }}>{fmtDay(ds)}</span>
                  <span style={{ flex: 1 }} /><span style={{ opacity: 0.5 }}>off</span>
                </div>
              );
              // Worked day — timeline card.
              const missingOut = segs.some(s => (s.flags || []).includes('missing_out'));
              const firstIn = segs[0].in;
              const lastOut = missingOut ? '' : segs[segs.length - 1].out;
              const worked = d.workedMin || 0;
              const ins = segs.map(s => msOf(s.in));
              const outs = segs.filter(s => s.out).map(s => msOf(s.out));
              const t0 = Math.min(...ins), maxIn = Math.max(...ins);
              let t1 = outs.length ? Math.max(...outs) : maxIn + 3600000;
              if (segs.some(s => !s.out)) t1 = Math.max(t1, maxIn + 3600000);
              const span = Math.max(t1 - t0, 1800000);
              return (
                <div key={ds} className="ts-day" style={{ ...CARD_S, padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', minWidth: 100 }}>{fmtDay(ds)}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {localTime(firstIn)} → {missingOut ? <span style={{ color: '#b45309', fontWeight: 700 }}>missing</span>
                        : lastOut ? localTime(lastOut) : <span style={{ color: 'var(--pine)', fontWeight: 700 }}>still in</span>}
                      {segs.length > 1 && <span> · {segs.length} sessions</span>}
                      {d.breakMin > 0 && <span> · {d.breakMin}m break</span>}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--pine)' }}>{fmtMin(worked)}</span>
                  </div>
                  {/* Timeline: each work session is a block placed by time-of-day; gaps are breaks. */}
                  <div style={{ position: 'relative', height: 24, borderRadius: 7, background: 'var(--mist)', overflow: 'hidden', marginBottom: 9 }}>
                    {segs.map((s, i) => {
                      const isOpen = !s.out;
                      const l = ((msOf(s.in) - t0) / span) * 100;
                      const w = Math.max(2, (((isOpen ? t1 : msOf(s.out)) - msOf(s.in)) / span) * 100);
                      return (
                        <div key={i} className="ts-block" title={`${localTime(s.in)} → ${s.out ? localTime(s.out) : 'missing'} · ${fmtMin(s.workedMin)}`}
                          style={{ position: 'absolute', left: `${l}%`, width: `${w}%`, top: 3, bottom: 3, borderRadius: 5,
                            background: isOpen ? 'repeating-linear-gradient(45deg,rgba(180,83,9,.28),rgba(180,83,9,.28) 6px,rgba(180,83,9,.12) 6px,rgba(180,83,9,.12) 12px)' : 'var(--pine)',
                            border: isOpen ? '1.5px dashed #b45309' : 'none' }} />
                      );
                    })}
                  </div>
                  {/* Session chips — every clock-in/out visible, with its action inline. */}
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                    {segs.map((s, i) => {
                      const open = !s.out;
                      return (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 9px', borderRadius: 8, fontSize: 11.5, fontWeight: 600,
                          background: open ? 'rgba(180,83,9,0.1)' : 'var(--mist)', color: open ? '#b45309' : 'var(--ink)' }}>
                          <span className={open ? 'ts-open' : ''} style={{ width: 7, height: 7, borderRadius: '50%', background: open ? '#b45309' : 'var(--pine)', flexShrink: 0 }} />
                          {localTime(s.in)} → {s.out ? localTime(s.out) : 'missing'}
                          <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{fmtMin(s.workedMin)}</span>
                          {open
                            ? <button className="primary-btn" onClick={() => openAddClockOut(s)} style={{ fontSize: 10.5, padding: '2px 8px', marginLeft: 2 }}>Add clock-out</button>
                            : s.inId && <button className="secondary-btn" onClick={() => requestRemovePunch({ id: s.inId })} style={{ fontSize: 10.5, padding: '2px 7px', marginLeft: 2 }}>Remove</button>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}
          {payData && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', marginTop: 4, borderTop: '2px solid var(--line)' }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>Total this period</span>
              <span style={{ flex: 1 }} />
              {PT.breakMin > 0 && <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 16 }}>{PT.breakMin}m break</span>}
              <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--pine)' }}>{fmtMin(PT.workedMin || 0)}</span>
            </div>
          )}
        </div>
      )}
      <p style={{ margin: '12px 2px 0', fontSize: 11, color: 'var(--muted)' }}>
        Each bar shows your work sessions through the day — a dashed block is a missing clock-out. Overtime is time over 40h in a week (1.5×). Use “Add clock-out” to fix a gap or “Remove” to drop a wrong punch — it goes to your approver, and nothing changes until they approve.
      </p>
      </>)}

      {/* Time off */}
      {tab === 'timeoff' && (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
        <CalendarDays size={15} style={{ color: 'var(--pine)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Time Off</span>
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '14px 16px', marginBottom: 10 }}>
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
      <div style={{ flex: '1.7 1 440px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', marginBottom: 24 }}>
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
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: TO_STATUS[r.status] || 'var(--muted)' }}>
              {r.status}
            </span>
          </div>
        ))}
      </div>

      {/* Year-at-a-glance side panel */}
      <div style={{ flex: '1 1 280px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>
          {new Date().getFullYear()} at a glance
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
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--pine)' }}>{totalDays}<span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}> day{totalDays !== 1 ? 's' : ''} approved</span></div>
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

      {/* Disclosed-monitoring consent gate — real notice the employee reads and
          acknowledges before the first in-punch is recorded. */}
      {monGate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1440, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 540, maxHeight: 'min(90dvh, 680px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
            <div style={{ padding: '15px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Monitor size={18} style={{ color: 'var(--pine)' }} />
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Before You Clock In</h3>
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>Please read and acknowledge how this device is monitored.</p>
              </div>
              <button onClick={() => setMonGate(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ padding: '16px 22px', overflowY: 'auto', fontSize: 13, color: 'var(--ink)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
              {monGate.text || 'This is a company-owned device. While you are clocked in, Greens Nexus records your worked time and may capture periodic screenshots of your work screen, the apps and windows you have open, and your overall activity level. This is used only to verify work time and activity — it never captures your keystrokes, and it stops the moment you clock out.'}
            </div>
            <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
                <input type="checkbox" checked={monAgree} onChange={e => setMonAgree(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--pine)' }} />
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
