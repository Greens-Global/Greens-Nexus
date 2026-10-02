import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Clock, LogIn, LogOut, Coffee, Play, MapPin, MapPinOff, AlertTriangle,
  CheckCircle, Plus, X, CalendarDays, Monitor, Lock,
  ChevronDown, Check, ClipboardCheck, ArrowRight,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import TimesheetsToReview from '../components/TimesheetsToReview';
import { openNotificationTarget } from '../lib/openTarget';
import { reasonLook, REQUEST_TIMEOFF_TYPES } from '../lib/timeOffReasons';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import DayTimeline from '../components/DayTimeline';
import ModuleTabs from '../components/ModuleTabs';
import PayrollTimecard from '../components/PayrollTimecard';
import BodModal from '../components/BodModal';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { punchDurable, replayPending, readPending, utcStamp } from '../lib/punchQueue';
import { replayPendingBods } from '../lib/bodQueue';
import { formatTime, formatDate, formatWeekday, formatHHMM, formatMonthDay, greetingFor } from '../lib/datetime';
import { getPosition, punchPosition } from '../lib/geoPosition';
import { MyHROverview } from './MyHR';
import { leaveRequestDays, openShiftMinutes } from '../lib/workdayStats';
import { timeOffLabel } from '../components/shiftScheduleLib';
import WorkdayShiftRequests from '../components/shifts/WorkdayShiftRequests';

// ── Workday ("My Workday" until Neil dropped the "My", Sep 23) - one module (Visesh, Sep 3: "combine My HR and Time Clock...
// anything to do with their time and HR should be together"; renamed from
// "My HR" Sep 4 once it covered both halves). Three tabs: Overview, Time
// Sheet, Time Off. The Time Clock is no longer its own tab (Neil, Oct 1: "is
// there a need for the clock to be its own screen? ... it should be a widget
// and it should have the entire time clock in it") - it is the first card on
// Overview (MyHR.jsx's MyHROverview, which takes it as `clock`), so the page
// people land on is the page they punch from. Old 'clock' links open
// Overview. Punch in/out keeps its geofencing (all employees) ──────────────
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
// What a punch reads as once it has happened (Neil, Sep 23: "Punched in at
// 1:40 PM", not "Punch In at 1:40 PM").
const KIND_DONE = { in: 'Punched in', out: 'Punched out', break_start: 'Break started', break_end: 'Break ended' };
// Per-tab page title/subtitle (Aug 31, per Pranshu - the header used to read
// "Time Clock" no matter which tab was open). `title` also drives the
// breadcrumb via <ModuleTabs syncTitle> below.
const TAB_META = {
  overview:  { title: 'Workday', label: 'Overview',   subtitle: 'Your clock, hours, documents and time off - only you see this' },
  timesheet: { title: 'Time Sheet', label: 'Time Sheet', subtitle: 'Your hours this pay period, day by day' },
  timeoff:   { title: 'Time Off',   label: 'Time Off',   subtitle: 'Request time off and see what’s coming up' },
};
// The Clock tab folded into Overview (Oct 2) - a bookmark, a bell or an
// email that still says 'clock' lands there.
const tabFor = (sub) => (sub === 'clock' ? 'overview' : sub);
// Work OS card-header title (sentence case, no uppercase tracking).
const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };

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
    /* Time Clock widget (Overview): the page's headline card - a greeting
       band, then the punch panel left and today/this week right. Brand-
       derived tints only, so a company's accent color carries through. */
    .wd-clock { background: var(--card); border: 1px solid var(--wk-line2); border-radius: 18px; box-shadow: var(--wk-shadow); overflow: hidden; }
    .wd-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 2px 0 14px; }
    .wd-intro-greet { margin: 0; font-size: 21px; font-weight: 700; color: var(--ink); letter-spacing: -.015em; }
    .wd-clock-body { display: grid; grid-template-columns: auto minmax(0, 1fr); }
    .wd-clock-main { padding: 18px 26px; display: flex; align-items: center; gap: 22px; min-width: 0; }
    .wd-clock-info { width: 250px; display: flex; flex-direction: column; gap: 10px; }
    .wd-clock--in .wd-clock-main { background: radial-gradient(circle at 16% 50%, color-mix(in srgb, var(--wk-brand) 8%, transparent) 0, transparent 60%); }
    .wd-clock--break .wd-clock-main { background: radial-gradient(circle at 16% 50%, rgba(180,83,9,.08) 0, transparent 60%); }
    .wd-state { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px 5px 10px; border-radius: 999px; font-size: 13px; font-weight: 700; }
    .wd-state--in { color: var(--wk-brand); background: color-mix(in srgb, var(--wk-brand) 12%, transparent); }
    .wd-state--break { color: #b45309; background: rgba(180,83,9,.1); }
    .wd-state--out { color: var(--muted); background: var(--mist); }
    .wd-since { margin-top: 6px; font-size: 13px; color: var(--muted); }
    .wd-since b { color: var(--ink); font-weight: 700; }
    .wd-punch { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: 12px; border: none; font-family: var(--wk-font);
      font-size: 14px; font-weight: 700; box-shadow: 0 1px 2px rgba(17,24,39,.08), 0 6px 16px -8px rgba(17,24,39,.35); transition: transform .12s ease, box-shadow .12s ease, filter .12s ease; }
    .wd-punch:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.05); box-shadow: 0 2px 4px rgba(17,24,39,.1), 0 10px 22px -8px rgba(17,24,39,.4); }
    .wd-punch:focus-visible { outline: 2px solid var(--wk-brand); outline-offset: 2px; }
    .wd-clock-side { padding: 14px 22px 16px; border-left: 1px solid var(--line); background: var(--wk-hover); display: flex; flex-direction: column; min-width: 0; }
    .wd-side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: none; }
    .wd-side-head > span:first-child { color: var(--ink); font-size: 13.5px; font-weight: 600; }
    .wd-link, .wd-flag { display: inline-flex; align-items: center; gap: 4px; background: none; border: none; padding: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; color: var(--wk-brand); }
    .wd-flag { color: #b45309; font-weight: 700; }
    .wd-empty { font-size: 12.5px; color: var(--muted); padding: 8px 0 2px; }
    .wd-hp-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .wd-seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--card); border: 1px solid var(--wk-line2); }
    .wd-seg button { border: none; background: none; font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); padding: 5px 12px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
    .wd-seg button:hover { color: var(--ink); }
    .wd-seg button.on { background: color-mix(in srgb, var(--wk-brand) 12%, transparent); color: var(--wk-brand); }
    .wd-seg button:focus-visible { outline: 2px solid var(--wk-brand); outline-offset: 1px; }
    .wd-hp-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 14px 0 12px; }
    .wd-hp-total { font-size: 28px; font-weight: 800; color: var(--ink); letter-spacing: -.02em; line-height: 1; font-variant-numeric: tabular-nums; }
    .wd-hp-cap { font-size: 12px; color: var(--muted); margin-top: 5px; }
    .wd-hp-facts { display: flex; gap: 22px; margin: 0; }
    .wd-hp-facts div { min-width: 0; }
    .wd-hp-facts dt { font-size: 11px; font-weight: 600; color: var(--muted); }
    .wd-hp-facts dd { margin: 2px 0 0; font-size: 14px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* Today is a slim timeline, so the card shrinks and the page moves up;
       the bar views share one height. */
    .wd-hp-viz > * { width: 100%; }
    .wd-bars-plot { position: relative; display: flex; align-items: flex-end; gap: 8px; height: 92px; padding-top: 14px; border-bottom: 1px solid var(--wk-line2); }
    .wd-bars-target { position: absolute; left: 0; right: 0; border-top: 1px dashed color-mix(in srgb, var(--muted) 55%, transparent); pointer-events: none; }
    .wd-bars-target em { position: absolute; right: 0; top: -15px; font-style: normal; font-size: 10px; font-weight: 600; color: var(--muted); }
    .wd-bar { position: relative; flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
    .wd-bar-fill { width: 100%; max-width: 34px; border-radius: 6px 6px 2px 2px; background: color-mix(in srgb, var(--wk-brand) 34%, transparent); transition: height .5s cubic-bezier(.22,1,.36,1); }
    .wd-bar.is-today .wd-bar-fill { background: var(--wk-brand); }
    .wd-bar.is-zero .wd-bar-fill { height: 3px; background: var(--wk-line2); }
    .wd-bar.is-future .wd-bar-fill { height: 0; }
    .wd-bar.is-future::after { content: ''; position: absolute; bottom: 0; width: 100%; max-width: 34px; height: 10px; border: 1px dashed var(--wk-line2); border-bottom: none; border-radius: 6px 6px 0 0; }
    .wd-bar-val { font-size: 10.5px; font-weight: 700; color: var(--ink); margin-bottom: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .wd-bars-x { display: flex; gap: 8px; margin-top: 6px; }
    .wd-bars-x span { flex: 1; min-width: 0; text-align: center; font-size: 10.5px; font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; }
    .wd-bars-x b { display: block; font-weight: 500; font-size: 10px; color: var(--wk-faint); }
    .wd-bars-x span.is-today, .wd-bars-x span.is-today b { color: var(--wk-brand); font-weight: 800; }
    .wd-metric { background: var(--card); border: 1px solid var(--wk-line2); border-radius: 10px; padding: 8px 11px; min-width: 0; }
    .wd-metric-l { font-size: 11px; font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wd-metric-v { font-size: 16px; font-weight: 700; color: var(--ink); margin-top: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .wd-week-total { font-size: 12.5px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
    [data-theme="dark"] .wd-clock-side { background: rgba(255,255,255,.02); }
    /* Overview tiles (dk-stat look, hero gradient included) in one compact
       row: chip, then number / label / hint, then the arrow. */
    .wd-statgrid { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .dk-stat.wd-stat.wd-hero { padding: 0; gap: 0; align-items: stretch; }
    .wd-hero-part { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; border-radius: inherit; transition: background .15s ease; }
    .wd-hero-part:first-child { flex: 1.15; }
    .wd-hero-part:hover:not(:disabled) { background: rgba(255,255,255,.08); }
    .wd-hero-part:disabled { cursor: default; }
    .wd-hero-part:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }
    .dk-stat.wd-hero:hover { transform: none; }
    .wd-hero-shift { flex: 1; position: relative; }
    .wd-hero-shift::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; border-left: 1px solid rgba(255,255,255,.28); }
    .wd-hero-shift-l { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,.8); }
    .wd-hero-shift-v { font-size: 16px; font-weight: 700; color: #fff; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wd-hero-shift-s { font-size: 11.5px; color: rgba(255,255,255,.72); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 1000px) { .wd-statgrid { grid-template-columns: 1fr 1fr; } .wd-statgrid > .wd-hero { grid-column: 1 / -1; } }
    @media (max-width: 600px) {
      .wd-statgrid { grid-template-columns: 1fr 1fr; gap: 10px; }
      .wd-hero .dk-stat-sub { display: block; }

      .dk-stat.wd-stat { padding: 10px 12px; gap: 10px; }
      .wd-stat .dk-chip { width: 30px; height: 30px; }
      .wd-stat .dk-stat-num { font-size: 18px; }
      .wd-stat .dk-stat-sub, .wd-stat .dk-stat-arrow { display: none; }
    }
    .dk-stat.wd-stat { flex-direction: row; align-items: center; gap: 12px; padding: 12px 14px; }
    .wd-stat .dk-chip { width: 34px; height: 34px; }
    .wd-stat-text { flex: 1; min-width: 0; }
    .wd-stat .dk-stat-num { font-size: 21px; margin-top: 0; line-height: 1.15; }
    .wd-stat .dk-stat-label { margin-top: 1px; font-size: 12.5px; }
    .wd-stat .dk-stat-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; }
    .wd-stat .dk-stat-arrow { flex-shrink: 0; }
    @media (max-width: 900px) { .wd-clock-body { grid-template-columns: 1fr; } .wd-clock-main { justify-content: center; flex-wrap: wrap; } .wd-clock-side { border-left: none; border-top: 1px solid var(--line); } }
    @media (max-width: 560px) { .wd-clock-head { padding: 12px 16px; } .wd-clock-main { padding: 16px; gap: 16px; } .wd-clock-info { width: 100%; } .wd-clock-side { padding: 14px 16px; } .wd-punch { flex: 1; justify-content: center; } }
    /* Clocked-in hero: pinging live dot, per-second digit tick, smooth ring sweep. */
    @keyframes tcPing { 0% { box-shadow: 0 0 0 0 var(--ping, rgba(34,150,83,.4)); } 70% { box-shadow: 0 0 0 10px rgba(0,0,0,0); } 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); } }
    @keyframes tcTick { from { transform: translateY(-40%); opacity: 0; } to { transform: none; opacity: 1; } }
    .tc-live { animation: tcPing 1.8s cubic-bezier(.22,1,.36,1) infinite; }
    .tc-tick { animation: tcTick .22s ease-out; }
    @media (prefers-reduced-motion: reduce) { .tc-live, .tc-tick { animation: none; } }`;
  document.head.appendChild(s);
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
  const size = 128, stroke = 8;
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--wk-line2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,1,.36,1), stroke .3s ease' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <TimerDigits seconds={seconds} color={color} size={21} />
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
        {sub && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{sub}</span>}
      </div>
    </div>
  );
}

// Clocked-out dial - the same footprint as SessionRing so the widget never
// jumps when you punch: an empty track around the wall-clock time.
function IdleDial({ now }) {
  const size = 128, stroke = 8;
  const r = (size - stroke) / 2;
  const [hm, ap] = formatTime(now).split(' ');
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--wk-line2)" strokeWidth={stroke} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{hm}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{ap}</span>
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Not Clocked In</span>
      </div>
    </div>
  );
}

// Daily hours as bars against the 8-hour line - the clock card's This Week
// and Pay Period views. Today is the solid brand bar; days still to come are
// dashed outlines; each worked day carries its hours above the bar.
const barHours = (m) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10}h` : `${m}m`);
function HoursBars({ series }) {
  const target = 8 * 60;
  const max = Math.max(target, ...series.map(x => x.min)) * 1.08;
  return (
    <div className="wd-bars">
      <div className="wd-bars-plot" role="list" aria-label="Hours by day">
        <span className="wd-bars-target" style={{ bottom: `${(target / max) * 100}%` }}><em>8h</em></span>
        {series.map(x => (
          <div key={x.key} role="listitem" title={`${formatWeekday(x.key + 'T12:00:00')}, ${formatDate(x.key + 'T12:00:00')} - ${fmtMin(x.min)}`}
            className={`wd-bar${x.today ? ' is-today' : ''}${x.future ? ' is-future' : ''}${!x.min && !x.future ? ' is-zero' : ''}`}>
            {x.min > 0 && <span className="wd-bar-val">{barHours(x.min)}</span>}
            <span className="wd-bar-fill" style={{ height: x.min ? `${Math.max(4, (x.min / max) * 100)}%` : undefined }} />
          </div>
        ))}
      </div>
      <div className="wd-bars-x">
        {series.map(x => (
          <span key={x.key} className={x.today ? 'is-today' : ''}>{x.label}<b>{x.sub}</b></span>
        ))}
      </div>
    </div>
  );
}

const localTime = (iso) => iso ? formatTime(iso + 'Z', '-') : '-';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;

// Break = formal Start Break time + clock-out/clock-in gaps up to 90 min (stepping
// away, incl. a long lunch). A gap over 90 min is OFF the clock (left / gone for the
// afternoon), not a break - matches the payroll timecard's break definition exactly.
const BREAK_GAP_MAX = 90;
const gapBreakFromPunches = (punches) => {
  let total = 0, lastOut = null;
  for (const p of (punches || [])) {
    if (p.kind === 'out') lastOut = p.at;
    else if (p.kind === 'in') {
      if (lastOut) { const m = Math.round((new Date(p.at + 'Z') - new Date(lastOut + 'Z')) / 60000); if (m > 0 && m <= BREAK_GAP_MAX) total += m; }
      lastOut = null;
    }
  }
  return total;
};
// 'HH:MM' (24h, from the partial-day time-off fields) -> '2:30 PM'
const hm12 = (v) => {
  if (!v) return '';
  const [h, m] = v.split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
// A partial-day request's window, for list rows: ' · 9:00 AM - 11:00 AM'
const toWindow = (r) => r?.startTime && r?.endTime ? ` · ${hm12(r.startTime)} - ${hm12(r.endTime)}` : '';
const TO_STATUS = { pending: '#b45309', approved: 'hsl(var(--color-green))', rejected: '#b91c1c', cancelled: 'var(--muted)' };
const TO_TINT = { pending: 'rgba(180,83,9,0.1)', approved: 'hsla(var(--color-green),0.1)', rejected: 'rgba(185,28,28,0.08)', cancelled: 'var(--mist)' };
const TO_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
// Field label on the request form.
const TO_LBL = { fontSize: 12, fontWeight: 600, color: 'var(--ink)' };
// 'YYYY-MM-DD' -> '10/02/2026' (noon, so no zone can roll it a day).
const toDay = (d) => formatDate(d ? d + 'T12:00:00' : '', d || '');

// Shared by the live "Total" preview on the request form and the year-at-a-
// glance sidebar's approved-days tally: WORKING days (Mon-Fri), a partial day
// as its fraction of an 8-hour day (lib/workdayStats.js - the same math as the
// Overview's "Leave this year" tile, so the numbers always agree).
const toDayCount = (start, end, startTime, endTime, year) =>
  leaveRequestDays({ startDate: start, endDate: end, startTime, endTime }, year);

const toMinutes = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

// Reason picker (Neil, Sep 30): Teams lists each kind of time off with its icon,
// which a native <select> can't draw - so a small listbox. Labeled "Reason"
// since Oct 1 (it IS the reason; the free text under it is the Note).
function ReasonPicker({ value, options, onChange, style }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const label = (options.find(([k]) => k === value) || [value, value])[1];
  const icon = (k, size = 14) => {
    const { Icon, color } = reasonLook(k, (options.find(([key]) => key === k) || [])[1]);
    return <Icon size={size} color={color} style={{ flexShrink: 0 }} />;
  };
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0, ...style }}>
      <button type="button" className="form-input" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Reason: ${label}`}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', textAlign: 'left', background: 'var(--card)' }}>
        {icon(value)}<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronDown size={13} color="var(--muted)" />
      </button>
      {open && (
        <div role="listbox" aria-label="Reason" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: '100%', width: 220, zIndex: 50,
          background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 10, boxShadow: 'var(--wk-shadow)', padding: '4px 0', maxHeight: 280, overflowY: 'auto' }}>
          {options.map(([k, l]) => (
            <button key={k} type="button" role="option" aria-selected={k === value} onClick={() => { onChange(k); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 12px', border: 'none', cursor: 'pointer', fontSize: 12.5,
                fontFamily: 'inherit', textAlign: 'left', color: 'var(--ink)', background: k === value ? 'var(--wk-brand-tint)' : 'none' }}>
              {icon(k, 15)}<span style={{ flex: 1 }}>{l}</span>{k === value && <Check size={13} color="var(--wk-brand)" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Teams-style "All day" switch (see TaskNotifySettings.jsx for the same
// anatomy) - kept local since this is the only place in Time Off that needs it.
function AllDayToggle({ on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onChange}
      title={on ? 'All day' : 'Specific hours'} style={{
        position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: on ? 'var(--wk-brand)' : 'var(--wk-line2)', transition: 'background 0.15s', flexShrink: 0,
      }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

// Shared-PC binding: mint a nonce and hand it to the LOCAL Nexus agent over
// localhost, so the agent claims this PC's device identity with its own token
// (the browser never sends a device_id). Returns the nonce to send with clock-in,
// or '' if there's no agent - a personal machine then clocks in unbound, exactly
// as before. Best-effort with a short timeout so it never blocks the punch.
const NEXUS_AGENT_PORT = 47615;
async function pairLocalAgent() {
  try {
    const { nonce } = await api.timeAgentPairChallenge();
    if (!nonce) return '';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    let ok = false;
    try {
      const r = await fetch(`http://127.0.0.1:${NEXUS_AGENT_PORT}/nexus/pair?nonce=${encodeURIComponent(nonce)}`,
        { signal: ctrl.signal });
      ok = r.ok;
    } catch { /* no agent reachable - unbound clock-in */ }
    clearTimeout(t);
    return ok ? nonce : '';
  } catch { return ''; }
}

function GeoChip({ p }) {
  if (!p) return null;
  if (p.geoStatus === 'in_fence') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}>
      <MapPin size={12} /> at {p.workSiteName || 'site'}
    </span>);
  if (p.geoStatus === 'out_of_fence') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#b45309' }}
      title={`Not inside any of your company's locations${p.workSiteName ? ` (nearest: ${p.workSiteName}, ${p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(1)} km` : `${p.distanceM} m`} away)` : ''}. Recorded and flagged for review - this never blocks your punch.`}>
      <AlertTriangle size={12} /> Out of Location - flagged
    </span>);
  // Tagged remote by HR: any location is accepted and nothing is flagged.
  if (p.geoStatus === 'remote') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}
      title="You are set up as remote, so you can punch from anywhere. Your location is still recorded with the punch.">
      <MapPin size={12} /> remote
    </span>);
  if (p.geoStatus === 'low_accuracy') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}
      title="This device gave only a rough Wi-Fi/IP location (no GPS) - too coarse to judge the geofence. Punch from a phone for a precise fix.">
      <MapPinOff size={12} /> approx. location (±{p.accuracyM >= 1000 ? `${(p.accuracyM / 1000).toFixed(1)}km` : `${p.accuracyM}m`})
    </span>);
  // No geofence verdict, but a location WAS captured (no geofenced work site to
  // judge against, or a coarse Wi-Fi/IP fix): still show the recorded location so
  // it doesn't read as "nothing was captured". Only a genuinely location-less
  // punch shows nothing (Neil, Jul 28 - an empty chip read as an error state).
  if (p.lat && p.lng) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}
      title="Location recorded. No geofenced location to judge against, or the fix was too coarse (Wi-Fi/IP, no GPS - punch from a phone for a precise fix).">
      <MapPin size={12} /> Location Recorded{p.accuracyM ? ` (±${p.accuracyM >= 1000 ? `${(p.accuracyM / 1000).toFixed(1)}km` : `${p.accuracyM}m`})` : ''}
    </span>);
  return null;
}

export default function TimeClock({ initialTab = 'clock', activeSub, onSubChange } = {}) {
  // The URL's sub segment is the source of truth once it names a real tab
  // (deep link, browser back/forward, or a bare /myhr landing on its default);
  // initialTab only seeds the very first render before that's known. Every
  // setTab(...) call below just updates local state - the effects further
  // down mirror it out to activeSub/the URL in one place, so no call site had
  // to change (Pranshu, Sep 4: switching tabs left the URL on /myhr forever).
  const [tab, setTab] = useState(() => {
    const t = tabFor(activeSub) || tabFor(initialTab);
    return TAB_META[t] ? t : 'overview';
  });
  // Workday > Shifts moved into the Shifts module (Sep 29). Old links - a
  // bookmark, a bell or schedule email sent before the move - land there.
  useEffect(() => {
    if (activeSub === 'shifts') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'shifts', sub: 'mine' } }));
  }, [activeSub]);   // overview | clock | timesheet | timeoff
  useEffect(() => {
    const t = tabFor(activeSub);
    if (TAB_META[t] && t !== tab) setTab(t);
    // An old 'clock' address already shows Overview - rewrite it to say so.
    else if (activeSub === 'clock' && onSubChange) onSubChange(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSub]);
  useEffect(() => {
    // Not while forwarding an old Shifts link - that would pull the address
    // back to this view on its way out.
    if (onSubChange && activeSub !== tab && activeSub !== 'shifts') onSubChange(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);        // {ok, text}
  const [bodMode, setBodMode] = useState(null);   // 'bod' | 'eod' | null - day-message modal
  // Disclosed-monitoring consent gate (first in-punch of the day). See doPunch/actualPunch.
  const [monGate, setMonGate] = useState(null);   // { text } | null
  const [monAgree, setMonAgree] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  // A punch that could not be recorded. The day-message gate posts to Teams
  // BEFORE the punch, so by the time this can happen the person has usually
  // already SEEN a Teams message saying they clocked in - a toast that fades in
  // six seconds is nowhere near loud enough to correct that.
  // Two pieces of state, deliberately: `parked` is the punch still owed, and it
  // outlives the dialog - dismissing the dialog must not stop Nexus recovering
  // in the background, or "Retry Later" becomes "throw it away".
  const [parked, setParked] = useState(() => {
    const p = readPending();
    return p ? { kind: p.kind, at: p.at, held: true } : null;
  });
  const [lostModal, setLostModal] = useState(false);
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
  // Landing a parked punch happens from four places - the background retry, the
  // Retry button, a DIFFERENT punch flushing the queue first, and a fresh page
  // load. One routine for all of them, so they can never drift apart on what
  // counts as recovered and what the person gets told.
  async function recoverPending() {
    const held = readPending();
    if (!held) { setParked(null); setLostModal(false); return { none: true }; }
    const r = await replayPending();
    if (r?.restored) {
      setParked(null); setLostModal(false);
      toast(true, `${KIND_DONE[r.entry.kind] || 'Punch recorded'} at ${localTime(r.punch.at)}`
        + `${r.backfilled ? ' - flagged for your approver to confirm.' : '.'}`);
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      load();
      return { done: true, ...r };
    }
    if (r?.dropped) {
      setParked(null); setLostModal(false);
      // A stale drop is NOT a quiet success. The punch they were waiting on is
      // gone; say so, or they carry on believing it landed.
      if (r.stale) toast(true, `Your ${(KIND_LABEL[held.kind] || 'punch').toLowerCase()} is already on your timecard - nothing left to record.`);
      else toast(false, r.error?.message || 'That punch could not be added - request it from your Time Sheet.');
      load();
      return { done: true, ...r };
    }
    return { stillDown: true };
  }

  // Nexus keeps trying on its own. The ordinary case is a phone that dropped one
  // packet, and that heals in seconds - so in almost every instance the employee
  // never has to do anything about it, which is the difference between a dialog
  // that hands them a problem and one that just tells them what happened.
  useEffect(() => {
    if (!parked?.held) return;
    let stop = false, delay = 4000, timer = 0;
    const attempt = async () => {
      if (stop || !readPending()) return;
      const r = await recoverPending();
      if (stop || !r.stillDown) return;
      delay = Math.min(delay * 2, 60000);
      timer = setTimeout(attempt, delay);
    };
    timer = setTimeout(attempt, 0);                  // first try immediately
    const soon = () => { if (stop) return; clearTimeout(timer); delay = 4000; timer = setTimeout(attempt, 600); };
    const onVis = () => { if (document.visibilityState === 'visible') soon(); };
    window.addEventListener('online', soon);         // the moment the device is back
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop = true; clearTimeout(timer);
      window.removeEventListener('online', soon);
      document.removeEventListener('visibilitychange', onVis);
    };
    // Keyed on the parked punch's time, not the object: the object is rebuilt on
    // every render and would restart the backoff into a tight poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parked?.held, parked?.at]);
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
    // A day message parked by bodQueue.js (the server could not be reached when
    // it was sent) goes out the moment anything can reach the server again.
    const replayBods = () => { replayPendingBods().catch(() => {}); };
    const onVis = () => { if (document.visibilityState === 'visible') { load(); loadMyRequests(); replayBods(); } };
    const onChange = () => { load(); loadMyRequests(); };   // a self add/remove request just fired
    replayBods();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('online', replayBods);
    window.addEventListener('nexus:timeclock-changed', onChange);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('online', replayBods);
      window.removeEventListener('nexus:timeclock-changed', onChange);
    };
  }, [load]);

  const [timeoff, setTimeoff] = useState(null);
  // allDay mirrors Teams' New Request toggle (Pranshu, Sep 16): on = whole
  // calendar day(s), no time fields; off = a specific window, which the
  // backend only accepts on a single day, so start/end date stay locked
  // together while it's off.
  const [toForm, setToForm] = useState({ type: 'personal', start: '', end: '', allDay: true, startTime: '', endTime: '', note: '', confidential: false });
  const [toBusy, setToBusy] = useState(false);
  const [toCancelling, setToCancelling] = useState(null);
  useEffect(() => { api.timeOffMine().then(setTimeoff).catch(() => setTimeoff([])); }, []);
  // The admins' requests on/off switch (Sep 29, Shifts settings). The
  // reasons themselves are the fixed REQUEST_TIMEOFF_TYPES list (Neil, Oct 1).
  const [toTypes, setToTypes] = useState(null);
  useEffect(() => { api.timeOffTypes().then(setToTypes).catch(() => setToTypes(null)); }, []);
  const toPartialOk = !toForm.allDay && toForm.start && toForm.end && toForm.start === toForm.end;
  // Live preview of what "Total" will show - same math as the year-at-a-
  // glance sidebar's approved-days tally, so the two numbers always agree.
  // Specific hours count in hours (Neil, Sep 30: 8:30 AM - 5:30 PM is "9
  // hours", not "1.13 days"); whole days stay in days.
  const toTotalHours = toPartialOk && toForm.startTime && toForm.endTime
    ? Math.max(0, (toMinutes(toForm.endTime) - toMinutes(toForm.startTime)) / 60) : 0;
  const toTotalDays = toForm.start && toForm.end
    ? toDayCount(toForm.start, toForm.end, toPartialOk ? toForm.startTime : '', toPartialOk ? toForm.endTime : '')
    : 0;

  function toggleAllDay() {
    setToForm(f => {
      const allDay = !f.allDay;
      // Turning the switch off only makes sense for one day - lock end to
      // start so the time fields that appear are always valid to submit.
      return { ...f, allDay, end: allDay ? f.end : f.start, startTime: allDay ? '' : f.startTime, endTime: allDay ? '' : f.endTime };
    });
  }

  async function submitTimeoff() {
    if (toBusy) return;
    if (!toForm.start || !toForm.end) { toast(false, 'Pick the start and end dates.'); return; }
    const st = toPartialOk ? toForm.startTime : '';
    const et = toPartialOk ? toForm.endTime : '';
    if (!toForm.allDay && (!st || !et)) { toast(false, 'Set the start and end times, or switch All day back on.'); return; }
    if (st && et && et <= st) { toast(false, 'The end time has to be after the start time.'); return; }
    // The Reason picker always says why; the Note under it is optional
    // (Neil, Oct 1 - "optional in terms of logic", but never labeled so).
    setToBusy(true);
    try {
      await api.timeOffCreate({ type: toForm.type, start_date: toForm.start, end_date: toForm.end,
        start_time: st, end_time: et, note: toForm.note.trim(), confidential: !!toForm.confidential });
      toast(true, 'Time-off request sent - your manager gets a notification.');
      setToForm({ type: 'personal', start: '', end: '', allDay: true, startTime: '', endTime: '', note: '', confidential: false });
      api.timeOffMine().then(setTimeoff).catch(() => {});
    } catch (e) { toast(false, e?.message || 'Could not send the request.'); }
    setToBusy(false);
  }

  async function cancelTimeoff(id) {
    if (toCancelling) return;
    setToCancelling(id);
    try {
      await api.timeOffCancel(id);
      toast(true, 'Request cancelled.');
      api.timeOffMine().then(setTimeoff).catch(() => {});
    } catch (e) { toast(false, e?.message || 'Could not cancel the request.'); }
    setToCancelling(null);
  }

  // The moment the punch button was PRESSED. The day-message gate opens before
  // the punch is sent, and the minutes spent writing that message are work -
  // the server backdates the punch to this stamp (bounded to 15 minutes).
  const gateClickRef = useRef('');

  async function doPunch(kind) {
    if (busy) return;
    const held = readPending();
    // THE SAME punch is already parked. Its Teams message went out with the first
    // attempt, and it carries the moment the button was really pressed - so
    // resume it instead of starting over. Re-running the gate would post a second
    // "I'm back from break" and re-stamp the punch minutes late, throwing away
    // exactly the minutes this whole thing exists to protect.
    if (held?.kind === kind) {
      setBusy(kind);
      await recoverPending();
      setBusy('');
      return;
    }
    // A DIFFERENT punch is parked - they've given up on the break end and are
    // clocking out. Land the parked one FIRST, in order: punching out moves the
    // state past a break end, after which it can never be placed and would be
    // thrown away without a word.
    if (held) {
      setBusy(kind);
      const r = await recoverPending();
      setBusy('');
      if (r.stillDown) {
        setLostModal(true);
        toast(false, `Your ${(KIND_LABEL[held.kind] || 'punch').toLowerCase()} still hasn't recorded. `
          + `That has to go in first - ${(KIND_META[kind]?.label || 'this punch').toLowerCase()} now would lose it.`);
        return;
      }
    }
    // Role-flagged people (Neil, Aug 25: field workers who cannot type) skip
    // every message prompt - the punch goes straight through.
    if (status?.bodExempt) {
      await actualPunch(kind);
      return;
    }
    // Login/break prompts come FIRST - the punch happens only after the message
    // is sent or explicitly acknowledged (see BodModal's ack-to-skip).
    // Every punch prompts for its message; the "already sent" checkbox lets a
    // repeat punch skip. (BOD gates punch-in, EOD gates checkout, break gates.)
    if (kind === 'in' || kind === 'break_start' || kind === 'break_end' || kind === 'out') {
      gateClickRef.current = new Date().toISOString().slice(0, 19);
      setBodMode(kind === 'in' ? 'bod-gate'
        : kind === 'break_start' ? 'break-gate'
        : kind === 'break_end' ? 'break-end-gate' : 'eod-gate');
      return;
    }
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
    // Short geo budget on the way out so the punch fires fast and can't be lost to
    // a closing tab; full budget on the way in for the geofence check. On the way
    // IN, pair with the local agent concurrently (shared-PC device binding) so it
    // adds no latency over the geolocation wait.
    const [pos, pairNonce] = await Promise.all([
      kind === 'out' ? punchPosition('out') : getPosition(9000),   // out: a recent fix if a fresh one is slow
      kind === 'in' ? pairLocalAgent() : Promise.resolve(''),
    ]);
    // punchDurable retries and, if the server still can't be reached, parks the
    // punch for replay. The Teams message has already gone out by this point, so
    // a punch quietly dropped here is the one failure this screen must not have.
    const clickedAt = gateClickRef.current;
    const res = await punchDurable({
      kind, tzOffsetMin: new Date().getTimezoneOffset(), clickedAt, pos,
      extra: pairNonce ? { pair_nonce: pairNonce } : null,
    });
    if (res.ok) {
      gateClickRef.current = '';
      const p = res.punch;
      const where = p.geoStatus === 'in_fence' ? ` at ${p.workSiteName}`
        : p.geoStatus === 'out_of_fence' ? ' - Out of Location, flagged for review'
        : p.geoStatus === 'remote' ? ' - remote'
        : p.geoStatus === 'low_accuracy' ? ' - location too approximate to judge (no GPS on this device)'
        : pos ? '' : ' - location unavailable, recorded without it';
      toast(true, `${KIND_DONE[kind] || KIND_META[kind].label} at ${localTime(p.at)}${where}.`);
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); // sync the global mini-timer
      load();
    } else {
      const e = res.error;
      // The backend can also gate the in-punch with a 409 - show the notice,
      // then retry once after the employee acknowledges (openMonGate → confirm).
      const needsConsent = e?.detail?.code === 'monitoring_consent_required'
        || /monitoring_consent_required/i.test(e?.message || '');
      if (kind === 'in' && !consented && needsConsent) {
        openMonGate(e?.detail);
        setBusy('');
        return;
      }
      // Unreachable is not the same as refused: the punch is missing rather than
      // wrong, so say so loudly instead of toasting it away.
      if (res.unreachable) {
        setParked({ kind, at: clickedAt || utcStamp(), held: !!res.queued });
        setLostModal(true);
      } else toast(false, e?.message || 'Punch failed.');
    }
    setBusy('');
  }

  // Retry a punch that didn't record. Always through the PARKED copy - it holds
  // the time the button was actually pressed, so a punch recovered ten minutes
  // later still lands at the minute they punched. When nothing could be parked
  // (storage blocked), there is no copy to resume and a fresh punch is all there
  // is; the message gate is skipped, since that message already went out.
  async function retryLostPunch() {
    if (busy) return;
    const kind = parked?.kind;
    setBusy(kind || 'retry');
    const r = readPending() ? await recoverPending() : { none: true };
    setBusy('');
    if (r.none && kind) { setParked(null); setLostModal(false); actualPunch(kind); return; }
    if (r.stillDown) {
      toast(false, "Still can't reach Nexus. Your punch is saved on this device and goes in by itself as soon as you're back online.");
    }
  }

  const last = status?.lastPunch;
  // The server closes a shift left open past the 16h guard (staleOpenShift):
  // it shows as Missing and is fixed by request, so this page is clocked OUT.
  const staleShift = !!status?.staleOpenShift;
  const clockedIn = !!last && last.kind !== 'out' && !staleShift;
  const onBreak = !!last && last.kind === 'break_start' && !staleShift;
  const sinceSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;
  const days = status?.days || {};

  // Long-session guard (Jul 27): the current session's in-punch, so we can tell
  // someone clocked in 12+ hours "still working, or forgot to punch out?" -
  // last.at alone isn't the session start when the newest punch is a break.
  const [longAckAt, setLongAckAt] = useState(() => Number(localStorage.getItem('nexus:longShiftAck') || 0));
  let sessionInAt = null, sessionDay = '';
  if (clockedIn) {
    // Track the DAY KEY of the session's in-punch too: a segment (and its break
    // allowance) belongs to the day the shift STARTED, not the wall-clock day.
    Object.entries(days).forEach(([dk, d]) => (d.punches || []).forEach(p => {
      if (p.kind === 'in' && !p.voided && (!sessionInAt || p.at > sessionInAt)) { sessionInAt = p.at; sessionDay = dk; }
    }));
    if (!sessionInAt && last?.kind === 'in') sessionInAt = last.at;
  }
  const sessionHours = sessionInAt ? (Date.now() - new Date(sessionInAt + 'Z').getTime()) / 3600000 : 0;
  const showLongBanner = clockedIn && sessionHours >= 12 && (Date.now() - longAckAt) > 4 * 3600000;


  const todayKey = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todayData = days[todayKey];
  // Daily break allowance: 1 hour. Count against the SHIFT's day (the in-punch's
  // date), not the wall-clock day - otherwise a night shift's allowance silently
  // resets at midnight mid-shift and stops warning. Falls back to today when not
  // clocked in (nothing open to attribute the meter to).
  const breakData = (clockedIn && sessionDay && days[sessionDay]) || todayData;
  const BREAK_ALLOWANCE_MIN = 60;
  const breakUsedMin = (breakData?.breakMin || 0) + gapBreakFromPunches(breakData?.punches) + (onBreak ? Math.floor(sinceSec / 60) : 0);
  const breakLeftMin = BREAK_ALLOWANCE_MIN - breakUsedMin;
  // The 60-minute countdown framing is an India-policy concept. US hourly staff
  // never see it (Neil, Aug 24: it reads as an entitlement and invites OT) -
  // they get plain elapsed break time instead. Server decides via the OT rule.
  const showAllowance = !!status?.breakCountdown;

  // ── Current pay period (the clock widget's Pay Period total). The Time Sheet tab is the
  //    PayrollTimecard, which loads and paginates periods on its own. ────────────
  const [clockPeriod, setClockPeriod] = useState(null);
  useEffect(() => {
    if (tab !== 'overview') return;
    const refresh = () => api.timeMyPayroll('').then(setClockPeriod).catch(() => setClockPeriod(null));
    refresh();
    // Every punch - here or from the floating timer - re-reads the period so
    // the hours update the moment you punch out (Neil, Sep 23).
    window.addEventListener('nexus:timeclock-changed', refresh);
    return () => window.removeEventListener('nexus:timeclock-changed', refresh);
  }, [tab]);
  // Which hours the clock card shows - Today / This Week / Pay Period. A
  // per-viewer convenience, so it is remembered in this browser only.
  const [hoursView, setHoursView] = useState(() => {
    try { return localStorage.getItem('nx-wd-hours-view') || 'week'; } catch { return 'week'; }
  });
  const pickHoursView = (v) => {
    setHoursView(v);
    try { localStorage.setItem('nx-wd-hours-view', v); } catch { /* storage blocked - fine */ }
  };
  // Today's scheduled shift(s) from Shifts, for the clock's greeting band.
  // null = not loaded (the line stays hidden rather than claiming "none").
  const [todayShifts, setTodayShifts] = useState(null);
  useEffect(() => {
    if (tab !== 'overview') return undefined;
    let live = true;
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    api.timeMySchedule(d, d)
      .then(r => { if (live) setTodayShifts((r?.scheduled || []).filter(x => x.date === d).sort((x, y) => (x.start || '').localeCompare(y.start || ''))); })
      .catch(() => { if (live) setTodayShifts(null); });
    return () => { live = false; };
  }, [tab]);

  // Timesheets to Review lives on this Time Sheet tab (Oct 1): the list of
  // timesheets submitted to me, with Agree / Send Back on each row - where the
  // "Timesheet to review" bell lands (timesheet_review._notify). It used to be
  // only in People > Time, which needs the HR grant a reviewing manager may
  // not have; Agree / Send Back themselves only need manager level. The count
  // is read once for the whole Workday (the badge, and the tab for a
  // time-tracking-exempt reviewer, who otherwise has no Time Sheet tab).
  // `|| {}`: the role context is null outside RoleProvider (render tests).
  const { can = () => false, myGrantedModules } = useRole() || {};
  const mayOpenTime = can('administrator') || !!myGrantedModules?.has('hr');
  const [toReview, setToReview] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => api.timesheetReviewWaiting()
      .then(r => { if (live) setToReview(Array.isArray(r?.reviews) ? r.reviews.length : 0); })
      .catch(() => {});
    load();
    window.addEventListener('nexus:timesheet-review-changed', load);
    return () => { live = false; window.removeEventListener('nexus:timesheet-review-changed', load); };
  }, []);
  const reviewRef = useRef(null);
  // Stable: TimesheetsToReview reloads whenever its onCount changes identity.
  const onReviewCount = useCallback((n) => { if (n != null) setToReview(n); }, []);
  const showReview = tab === 'timesheet' && toReview > 0;
  const openReview = () => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Review opens that employee's full timecard in People > Time - only for
  // those who can open it (administrator, or the HR grant - App.jsx's gate).
  const openTimecardFor = mayOpenTime ? (r) => {
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'hr', sub: 'hr-time' } }));
    openNotificationTarget({ timecard: r.employeeEmail, start: r.periodStart, payType: r.payType });
  } : undefined;

  // ── The Time Clock widget (top of Overview, Oct 2) ─────────────────────────
  // The page's one headline: a greeting with today's scheduled shift, the
  // live dial, the punch buttons, then today's timeline, the running totals
  // and the week at a glance. The banners that must not be missed (a 12-hour
  // shift, a punch that did not record, a shift left open) sit inside it,
  // right above the buttons they concern. Every color comes from the brand
  // tokens so a company's own accent carries through.
  const now = new Date();
  // Today's minutes so far: finished segments plus the one still running
  // (the server counts a segment only once it closes).
  const liveMin = clockedIn && !onBreak ? openShiftMinutes(days) : 0;
  const liveDay = sessionDay || todayKey;
  const workedToday = (todayData?.workedMin || 0) + (liveDay === todayKey ? liveMin : 0);
  const periodMin = (clockPeriod?.totals?.workedMin || 0) + liveMin;
  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayOf = (k) => new Date(k + 'T12:00:00');
  const withLive = (k, min) => (min || 0) + (k === liveDay ? liveMin : 0);
  const avgOf = (total, n) => (n ? fmtMin(Math.round(total / n)) : '-');
  const hp = (() => {
    if (hoursView === 'today') {
      const firstIn = (todayData?.punches || []).find(p => p.kind === 'in' && !p.voided);
      return {
        total: workedToday, caption: 'Worked today',
        facts: [
          ['Breaks', showAllowance ? `${breakUsedMin} / 60m` : `${breakUsedMin}m`, showAllowance && breakUsedMin > 60],
          ['First In', firstIn ? localTime(firstIn.at) : '-'],
        ],
        series: [],
      };
    }
    if (hoursView === 'period') {
      // Every day of the period, start to end - the payroll list carries
      // only the days that have hours.
      const byDay = Object.fromEntries((clockPeriod?.days || []).map(d => [d.date, d.workedMin || 0]));
      const series = [];
      if (clockPeriod?.periodStart && clockPeriod?.periodEnd) {
        for (let d = dayOf(clockPeriod.periodStart); keyOf(d) <= clockPeriod.periodEnd && series.length < 31; d.setDate(d.getDate() + 1)) {
          const k = keyOf(d);
          series.push({ key: k, label: formatWeekday(d, 'narrow'), sub: String(d.getDate()),
            min: withLive(k, byDay[k]), today: k === todayKey, future: k > todayKey });
        }
      }
      const worked = series.filter(x => x.min > 0).length;
      return {
        total: periodMin,
        caption: clockPeriod?.periodStart ? `Worked ${formatMonthDay(dayOf(clockPeriod.periodStart))} - ${formatMonthDay(dayOf(clockPeriod.periodEnd))}` : 'Worked this pay period',
        facts: [['Days Worked', String(worked)], ['Daily Avg', avgOf(periodMin, worked)]],
        series,
      };
    }
    const base = dayOf(todayKey);
    const monday = new Date(base); monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    const series = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const k = keyOf(d);
      return { key: k, label: formatWeekday(d, 'short'), sub: String(d.getDate()), min: withLive(k, days[k]?.workedMin), today: k === todayKey, future: k > todayKey };
    });
    const total = series.reduce((a, x) => a + x.min, 0);
    const worked = series.filter(x => x.min > 0).length;
    const breaks = series.reduce((a, x) => a + (days[x.key]?.breakMin || 0), 0);
    return {
      total, caption: `Worked this week · ${formatMonthDay(dayOf(series[0].key))} - ${formatMonthDay(dayOf(series[6].key))}`,
      facts: [['Days Worked', String(worked)], ['Daily Avg', avgOf(total, worked)], ['Breaks', `${breaks}m`]],
      series,
    };
  })();
  const tone = onBreak ? 'break' : clockedIn ? 'in' : 'out';
  // Today's shift for Overview's Hours tile (Oct 2 - it sits beside this
  // week's hours rather than as a grey line under the greeting). null while
  // loading, so the tile never claims "no shift" before it knows.
  const todayShift = todayShifts === null ? null : todayShifts.length
    ? { time: todayShifts.map(x => `${formatHHMM(x.start)} - ${formatHHMM(x.end)}`).join(', '), label: todayShifts[0].label || '' }
    : { time: '', label: '' };

  // Overview's top, in reading order (Oct 2): `intro` - the greeting with the
  // day and today's shift, as plain page text - then MyHR's summary tiles,
  // then `card` - the clock itself, which opens straight onto the punch
  // panel and the hours panel (no header band of its own).
  const clockIntro = (firstName) => (
    <div className="wd-intro">
      <div style={{ minWidth: 0 }}>
        <h3 className="wd-intro-greet">{greetingFor(now)}{firstName ? `, ${firstName}` : ''}</h3>
      </div>
    </div>
  );
  const clockWidget = (firstName) => ({ intro: clockIntro(firstName), card: clockCard(), shift: todayShift });
  const clockCard = () => status?.timeTrackingExempt ? (
    /* Salaried/exempt people see no punch UI or hours at all (Charmi, Aug 21:
       "if you're salaried, there should be an option that this turns off"). */
    <div className="dash-card" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, padding: '16px 20px' }}>
      <span className="dk-chip dk-chip--brand"><Clock /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Time Tracking Is Off for You</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          You're on a salaried, time-tracking-exempt setup, so Nexus doesn't record punches or hours for you. Time off still works from the Time Off tab.
        </div>
      </div>
    </div>
  ) : (
    <div style={{ marginBottom: 18 }}>
      {showLongBanner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12, padding: '12px 16px', borderRadius: 12, background: 'rgba(180,83,9,0.09)', border: '1.5px solid rgba(180,83,9,0.4)' }}>
          <AlertTriangle size={17} style={{ color: '#b45309', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#b45309', flex: 1, minWidth: 220 }}>
            You've been clocked in for {Math.floor(sessionHours)} hours - still working, or did you forget to punch out?
          </span>
          <button className="secondary-btn" style={{ fontSize: 12 }}
            onClick={() => { const t = Date.now(); localStorage.setItem('nexus:longShiftAck', String(t)); setLongAckAt(t); }}>
            I'm Still Working
          </button>
          <button className="primary-btn" style={{ fontSize: 12 }}
            onClick={() => {
              // The fix lives inline on the Time Sheet: click the red "Missing" out-cell
              // to send an approver-confirmed clock-out request.
              setTab('timesheet');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}>
            Fix My Punch Out
          </button>
        </div>
      )}
      <section className={`wd-clock wd-clock--${tone}`} aria-label="Time Clock">
        {!status ? (
          <div style={{ padding: '22px 24px' }}><SkeletonBlocks count={2} height={20} /></div>
        ) : (
          <div className="wd-clock-body">
            <div className="wd-clock-main">
              {clockedIn ? (
                /* Working: stopwatch dial, one sweep per hour of this session.
                   On break: arc = the 60m allowance draining (red once over). */
                <SessionRing seconds={sinceSec}
                  pct={onBreak && showAllowance ? breakUsedMin / BREAK_ALLOWANCE_MIN : (sinceSec % 3600) / 3600}
                  color={onBreak ? (showAllowance && breakLeftMin < 0 ? '#b91c1c' : '#b45309') : 'var(--wk-brand)'}
                  label={onBreak ? 'On Break' : 'This Session'}
                  sub={onBreak && showAllowance ? (breakLeftMin >= 0 ? `${breakLeftMin}m of 60m left` : `${-breakLeftMin}m over 60m`) : undefined} />
              ) : <IdleDial now={now} />}
              <div className="wd-clock-info">
                <div>
                  <span className={`wd-state wd-state--${tone}`}>
                    <span className={clockedIn ? 'tc-live' : ''} style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', flexShrink: 0,
                      '--ping': onBreak ? 'rgba(180,83,9,.4)' : 'color-mix(in srgb, var(--wk-brand) 40%, transparent)' }} />
                    {onBreak ? 'On Break' : clockedIn ? 'Clocked In' : 'Clocked Out'}
                  </span>
                  <div className="wd-since">
                    {last && !staleShift
                      ? <>{KIND_DONE[last.kind] || 'Last punch'} at <b>{localTime(last.at)}</b></>
                      : 'Punch in when you start - your location is checked at that moment only.'}
                  </div>
                  {last && !staleShift && <div style={{ marginTop: 6 }}><GeoChip p={last} /></div>}
                </div>
                {onBreak && (
                  <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 10,
                    background: showAllowance && breakLeftMin < 0 ? 'hsla(var(--color-red),0.1)' : 'rgba(180,83,9,0.09)',
                    color: showAllowance && breakLeftMin < 0 ? 'hsl(var(--color-red))' : '#b45309', fontSize: 13, fontWeight: 700 }}>
                    <Coffee size={14} />
                    {!showAllowance
                      ? `On break for ${breakUsedMin} min today`
                      : breakLeftMin >= 0
                        ? `${breakLeftMin} min left of your 1h daily break`
                        : `Break over by ${-breakLeftMin} min - over your 1h daily allowance`}
                  </div>
                )}
                {/* Dismissing the dialog must not leave silence - the punch is still
                    owed, and this is the line that stops them "fixing" it by
                    punching out. It clears itself the moment the punch lands. */}
                {parked && !lostModal && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '9px 13px', borderRadius: 10,
                    background: 'hsla(var(--color-red),0.09)', color: 'hsl(var(--color-red))', fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 200 }}>
                      Your {(KIND_LABEL[parked.kind] || 'punch').toLowerCase()} at {localTime(parked.at)} still
                      hasn&apos;t recorded.{parked.held ? ' Nexus is still trying - it will go in at that time. Don’t punch out to fix it.' : ' Retry from this screen.'}
                    </span>
                    <button onClick={retryLostPunch} disabled={!!busy}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer', font: 'inherit', fontWeight: 700, color: 'inherit', textDecoration: 'underline' }}>
                      Retry Now
                    </button>
                  </div>
                )}
                {staleShift && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12,
                    background: 'hsla(var(--color-red),0.09)', color: 'hsl(var(--color-red))', fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>
                    <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 200 }}>
                      Your clock-in{status.staleOpenSince ? ` at ${localTime(status.staleOpenSince)}` : ''} was never closed and is more than 16 hours old, so that shift shows as Missing.
                      Submit a Missed Punch request with the real clock-out time - and clock in to start today.
                    </span>
                    <button className="primary-btn" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => setTab('timesheet')}>
                      Fix My Punch Out
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {(status.allowed || []).map(kind => {
                    const M = KIND_META[kind];
                    return (
                      <button key={kind} className="wd-punch" onClick={async () => {
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
                        style={{ background: M.bg, color: M.fg, opacity: busy && busy !== kind ? 0.55 : 1, cursor: busy ? 'default' : 'pointer' }}>
                        {busy === kind ? <Spinner size="inline" /> : <M.Icon size={17} />}
                        {busy === kind ? 'Getting location…' : M.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Hours panel (Oct 2, the pattern Jibble / ZEP / Rippling use):
                ONE view at a time behind a Today / Week / Pay Period switch -
                a big total, a few quiet supporting numbers, then a single
                picture of it (today's punches, or daily bars against the
                8-hour line). Replaces a stacked timeline + metric boxes +
                separate chart that all said the same thing. */}
            <div className="wd-clock-side">
              <div className="wd-hp-top">
                <div className="wd-seg" role="tablist" aria-label="Hours for">
                  {[['today', 'Today'], ['week', 'This Week'], ['period', 'Pay Period']].map(([k, l]) => (
                    <button key={k} type="button" role="tab" aria-selected={hoursView === k}
                      className={hoursView === k ? 'on' : ''} onClick={() => pickHoursView(k)}>{l}</button>
                  ))}
                </div>
                {todayData?.flags?.length > 0 ? (
                  <button onClick={() => setTab('timesheet')} className="wd-flag">
                    <AlertTriangle size={11} /> {todayData.flags.length} item{todayData.flags.length === 1 ? '' : 's'} for review
                  </button>
                ) : (
                  <button className="wd-link" onClick={() => setTab('timesheet')}>Time Sheet <ArrowRight size={12} /></button>
                )}
              </div>

              <div className="wd-hp-head">
                <div>
                  <div className="wd-hp-total">{fmtMin(hp.total)}</div>
                  <div className="wd-hp-cap">{hp.caption}</div>
                </div>
                <dl className="wd-hp-facts">
                  {hp.facts.map(([l, v, warn]) => (
                    <div key={l}><dt>{l}</dt><dd style={warn ? { color: 'hsl(var(--color-red))' } : undefined}>{v}</dd></div>
                  ))}
                </dl>
              </div>

              {hoursView === 'today' ? (
                todayData?.punches?.length
                  ? <div className="wd-hp-viz"><DayTimeline punches={todayData.punches} date={todayKey} /></div>
                  : <div className="wd-hp-viz wd-empty">No punches yet today - punch in and your day draws here.</div>
              ) : (
                <div className="wd-hp-viz"><HoursBars series={hp.series} /></div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );

  return (
    <div style={{ fontFamily: 'var(--wk-font)', animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Standard module header band (view-header carries the hairline divider
          that separates every module's title from its content). */}
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {tab === 'timeoff' ? <CalendarDays size={19} /> : <Clock size={19} />}
          </span>
          <div className="view-title-group">
            <h2 style={{ margin: 0 }}>{TAB_META[tab].title}</h2>
            <p style={{ margin: '2px 0 0' }}>{TAB_META[tab].subtitle}</p>
          </div>
        </div>
        {showReview && (
          <button type="button" className={toReview > 0 ? 'primary-btn' : 'secondary-btn'} onClick={openReview}
            title="Jump to the timesheets submitted to you - agree to them or send them back"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, alignSelf: 'center', whiteSpace: 'nowrap' }}>
            <ClipboardCheck size={15} /> Timesheets to Review
            {toReview > 0 && (
              <span aria-label={`${toReview} waiting`} style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, background: '#fff', color: 'var(--wk-brand)',
                fontSize: 11.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{toReview}</span>
            )}
          </button>
        )}
      </div>

      {/* Tabs - one job per screen (the everything-in-one page read as clutter).
          Desktop renders them centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both). syncTitle: the header/page
          title above follows whichever tab is active instead of always
          reading "Time Clock". Overview always leads - My HR content applies
          to everyone regardless of time-tracking-exempt status. */}
      <ModuleTabs
        tabs={(status?.timeTrackingExempt
          /* Salaried/exempt (Charmi, Aug 21): no punch card, no timesheet -
             time off is the only surface that applies. */
          ? ['overview', ...(toReview > 0 || tab === 'timesheet' ? ['timesheet'] : []), 'timeoff']
          : ['overview', 'timesheet', 'timeoff']
        ).map((key) => ({ key, label: TAB_META[key].label, title: TAB_META[key].title }))}
        active={tab} onChange={setTab} syncTitle />

      {msg && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: msg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: msg.ok ? 'hsl(var(--color-green))' : '#b91c1c', fontSize: 13, fontWeight: 600 }}>
          {msg.ok ? <CheckCircle size={15} /> : <AlertTriangle size={15} />} {msg.text}
        </div>
      )}

      {/* Overview: the Time Clock widget first, then the employee's own HR
          page (profile, hours, documents, time off, Ask HR). */}
      {tab === 'overview' && (
        <MyHROverview clock={clockWidget} onOpenTimeOff={() => setTab('timeoff')} onOpenTimeSheet={status?.timeTrackingExempt ? undefined : () => setTab('timesheet')} />
      )}

      {/* Timesheets submitted to me, not decided yet - above my own timesheet,
          for exempt reviewers too. Renders nothing when nothing is waiting. */}
      {tab === 'timesheet' && (
        <div ref={reviewRef} style={{ scrollMarginTop: 80 }}>
          <TimesheetsToReview toastOk={t => toast(true, t)} toastErr={t => toast(false, t)}
            onCount={onReviewCount} onOpen={openTimecardFor} />
        </div>
      )}
      {tab === 'timesheet' && status?.timeTrackingExempt && toReview === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 2px' }}>Nothing is waiting on you to review.</div>
      )}

      {/* Timesheet - day list + week summary side panel */}
      {tab === 'timesheet' && !status?.timeTrackingExempt && (<>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
          <span className="wkc-chip"><CalendarDays size={14} /></span>
          <span style={HD}>Request Time Off</span>
        </div>
        {/* Labeled fields that wrap on their own (Oct 2): Reason (the type,
            Neil Oct 1 - "the first thing that says Vacation was supposed to
            be Reason"), From, To, All day; the hours row when it is part of
            a day; then a free-text Note - optional, not labeled optional
            ("it's always in our interest to get details"). */}
        {toTypes && toTypes.requestsOn === false ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Time-off requests are turned off. Ask your manager to add your time off.</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'end' }}>
              <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
                <span style={TO_LBL}>Reason</span>
                <ReasonPicker value={toForm.type} options={REQUEST_TIMEOFF_TYPES} onChange={type => setToForm(f => ({ ...f, type }))} />
              </div>
              <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
                <span style={TO_LBL}>From</span>
                <input className="form-input" type="date" value={toForm.start}
                  onChange={e => setToForm(f => ({ ...f, start: e.target.value, end: f.allDay ? (f.end && f.end >= e.target.value ? f.end : e.target.value) : e.target.value }))}
                  style={{ fontSize: 12.5, minWidth: 0 }} />
              </label>
              <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
                <span style={TO_LBL}>To</span>
                <input className="form-input" type="date" value={toForm.end} disabled={!toForm.allDay} min={toForm.start || undefined}
                  title={toForm.allDay ? undefined : 'A specific-hours request is single-day only'}
                  onChange={e => setToForm(f => ({ ...f, end: e.target.value }))}
                  style={{ fontSize: 12.5, minWidth: 0, opacity: toForm.allDay ? 1 : 0.55 }} />
              </label>
              {/* Teams' New Request "All day" switch (Pranshu, Sep 16): on = whole
                  day(s), off = a specific start/end time on that one day. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', whiteSpace: 'nowrap', height: 36 }}>
                <AllDayToggle on={toForm.allDay} onChange={toggleAllDay} />
                All day
              </label>
            </div>

            {/* Specific hours: only offered on a one-day range, since that's
                all the backend accepts a start/end time on. */}
            {!toForm.allDay && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 220px))', gap: 12 }}>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={TO_LBL}>Start time</span>
                  <input className="form-input" type="time" value={toForm.startTime}
                    onChange={e => setToForm(f => ({ ...f, startTime: e.target.value }))} style={{ fontSize: 12.5 }} />
                </label>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={TO_LBL}>End time</span>
                  <input className="form-input" type="time" value={toForm.endTime}
                    onChange={e => setToForm(f => ({ ...f, endTime: e.target.value }))} style={{ fontSize: 12.5 }} />
                </label>
              </div>
            )}

            <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
              <span style={TO_LBL}>Note</span>
              <textarea className="form-input" aria-label="Note" placeholder="Anything your approver should know" value={toForm.note} rows={2}
                maxLength={400} onChange={e => setToForm(f => ({ ...f, note: e.target.value }))}
                style={{ fontSize: 12.5, resize: 'vertical', fontFamily: 'inherit', minWidth: 0 }} />
            </label>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
              {/* Confidential (Neil, Sep 29/30): the team sees that you're out
                  and the type ("Time off - Medical"); the note stays between
                  you and your approver. */}
              <label style={{ flex: '1 1 320px', display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)' }}>
                <input type="checkbox" checked={!!toForm.confidential} onChange={e => setToForm(f => ({ ...f, confidential: e.target.checked }))}
                  style={{ marginTop: 2 }} />
                <span>
                  <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Keep this confidential</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    Your team sees that you're out and the reason (for example Sick). Your note is visible only to you and your approver (your manager).
                  </span>
                </span>
              </label>
              {/* Total: a live read of what this request will count as.
                  Specific hours count in hours (Neil, Sep 30: 8:30 AM - 5:30 PM
                  is "9 hours", not "1.13 days"); whole days in working days. */}
              {(toTotalHours > 0 || (!toPartialOk && toTotalDays > 0)) && (
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--wk-brand)', display: 'flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap', paddingBottom: 9 }}>
                  Total
                  {toPartialOk ? (
                    <>
                      <span style={{ fontSize: 13.5 }}>{Math.round(toTotalHours * 100) / 100}</span>
                      <span style={{ fontWeight: 600, color: 'var(--muted)' }}>hour{toTotalHours === 1 ? '' : 's'}</span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 13.5 }}>{Math.round(toTotalDays * 100) / 100}</span>
                      <span style={{ fontWeight: 600, color: 'var(--muted)' }}>working day{toTotalDays === 1 ? '' : 's'}</span>
                    </>
                  )}
                </span>
              )}
              <button className="primary-btn" onClick={submitTimeoff} disabled={toBusy}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 120 }}>
                {toBusy ? <Spinner size={13} /> : <Plus size={13} />} Request
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Shift Requests (Charmi, 09/30): swaps, offers and open-shift requests
          live here with the time-off form, not in the Shifts module. */}
      <WorkdayShiftRequests toast={toast} />
      {/* My requests, full width. The year-at-a-glance panel is gone (Neil,
          Oct 1: "old and useless") - the year's approved total is a tile on
          Overview. */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, overflow: 'hidden', marginBottom: 24, boxShadow: 'var(--wk-shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 16px', borderBottom: '1px solid var(--line)' }}>
          <span style={HD}>My Requests</span>
          {(timeoff || []).some(r => r.status === 'pending') && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 999, background: TO_TINT.pending, color: TO_STATUS.pending }}>
              {(timeoff || []).filter(r => r.status === 'pending').length} Pending
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Your manager decides - you get a bell notification</span>
        </div>
        {timeoff === null && <div style={{ padding: 16 }}><SkeletonBlocks count={2} height={18} /></div>}
        {Array.isArray(timeoff) && timeoff.length === 0 && (
          <div style={{ padding: '18px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
            No time-off requests yet.
          </div>
        )}
        {(timeoff || []).map(r => {
          const label = timeOffLabel(r.type);
          const { Icon: TIcon, color } = reasonLook(r.type, label);
          const days = r.startDate === r.endDate ? toDay(r.startDate) : `${toDay(r.startDate)} - ${toDay(r.endDate)}`;
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--mist)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <TIcon size={15} color={color} />
              </span>
              <div style={{ minWidth: 160, flex: '0 1 240px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  {label}{r.confidential && <ConfidentialBadge />}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{days}{toWindow(r)}</div>
              </div>
              <div style={{ flex: 1, minWidth: 120, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.note || undefined}>
                {r.note ? <>Note: {r.note}</> : null}
              </div>
              {r.decideNote && <span style={{ fontSize: 11, color: 'var(--muted)' }} title={r.decideNote}>💬</span>}
              {/* The requester can withdraw their own request while it's still
                  pending or before it's actually decided against, i.e. anything
                  not already rejected/cancelled (Pranshu, Sep 16 - there was no
                  way to take a request back once filed). */}
              {(r.status === 'pending' || r.status === 'approved') && (
                <button onClick={() => cancelTimeoff(r.id)} disabled={toCancelling === r.id}
                  title="Cancel this request"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                    cursor: toCancelling === r.id ? 'default' : 'pointer', fontSize: 11, fontWeight: 700, color: '#b91c1c',
                    padding: '2px 6px', opacity: toCancelling === r.id ? 0.5 : 1 }}>
                  {toCancelling === r.id ? <Spinner size={11} /> : <X size={11} />} Cancel
                </button>
              )}
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 999, minWidth: 74, textAlign: 'center',
                background: TO_TINT[r.status] || 'var(--mist)', color: TO_STATUS[r.status] || 'var(--muted)' }}>
                {TO_STATUS_LABEL[r.status] || r.status}
              </span>
            </div>
          );
        })}
      </div>
      </>)}

      {bodMode && (() => {
        const modalMode = bodMode === 'bod-gate' ? 'bod'
          : bodMode === 'break-gate' ? 'break'
          : bodMode === 'break-end-gate' ? 'break_end'
          : bodMode === 'eod-gate' ? 'eod' : bodMode;
        // All gates hold the punch until the message is sent OR explicitly
        // acknowledged (ack-to-skip). Closing the modal cancels the punch.
        const proceed = bodMode === 'bod-gate' ? () => { setBodMode(null); actualPunch('in'); }
          : bodMode === 'break-gate' ? () => { setBodMode(null); actualPunch('break_start'); }
          : bodMode === 'break-end-gate' ? () => { setBodMode(null); actualPunch('break_end'); }
          : bodMode === 'eod-gate' ? () => { setBodMode(null); actualPunch('out'); }
          : () => setBodMode(null);
        const onSkip = bodMode === 'bod-gate' ? () => { bodMarker('bod'); proceed(); }
          : bodMode === 'eod-gate' ? () => { bodMarker('eod'); proceed(); }
          : proceed;
        return <BodModal mode={modalMode} required onSent={proceed} onSkip={onSkip}
          onClose={() => { gateClickRef.current = ''; setBodMode(null); }}
          toastOk={t => toast(true, t)} toastErr={t => toast(false, t)} />;
      })()}

      {/* A punch that did NOT record. The Teams message for this punch has almost
          certainly already landed, so the person believes they are clocked in -
          this has to correct that belief. But it must not hand them a job: the
          copy's whole work is to say "we are handling it, don't punch anything
          else", because every improvised recovery they could try makes it worse. */}
      {parked && lostModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1440, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div role="alertdialog" aria-modal="true" aria-label="Your punch did not record"
            style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 480, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
            <div style={{ padding: '15px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="wkc-chip" style={{ color: 'hsl(var(--color-red))' }}><AlertTriangle size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Your Punch Did Not Record</h3>
            </div>
            <div style={{ padding: '16px 22px', fontSize: 13, color: 'var(--ink)', lineHeight: 1.65 }}>
              Nexus couldn&apos;t reach the server, so your <b>{(KIND_LABEL[parked.kind] || 'punch').toLowerCase()}</b> at{' '}
              <b>{localTime(parked.at)}</b> is not on your timecard yet. Your Teams message may already
              have gone out - that does not record a punch.
              {parked.held ? (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--wk-hover)', color: 'var(--ink)' }}>
                  <b>You don&apos;t need to do anything.</b> The punch is saved on this device at{' '}
                  {localTime(parked.at)} and Nexus keeps trying on its own - it goes in at that time,
                  not whenever it finally gets through. Please don&apos;t punch out to fix it; that would
                  end your day instead.
                </div>
              ) : (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--wk-hover)', color: 'var(--ink)' }}>
                  This browser couldn&apos;t save it either, so retry while you&apos;re on this screen. If it
                  still won&apos;t go, ask for it from your Time Sheet - don&apos;t punch out to work around it.
                </div>
              )}
            </div>
            <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setLostModal(false)}>
                {parked.held ? 'OK, Keep Trying' : 'Close'}
              </button>
              <button className="primary-btn" onClick={retryLostPunch} disabled={!!busy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Spinner size={13} /> : <CheckCircle size={14} />} Retry Now
              </button>
            </div>
          </div>
        </div>
      )}

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
                  {monBusy ? <Spinner size={13} /> : <CheckCircle size={14} />} Acknowledge &amp; clock in
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Lock + "Confidential" chip on a confidential time-off row (Sep 29).
function ConfidentialBadge() {
  return (
    <span title="Confidential - only you and your approver see the note"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
        background: 'var(--mist)', borderRadius: 999, padding: '2px 8px' }}>
      <Lock size={10} /> Confidential
    </span>
  );
}
