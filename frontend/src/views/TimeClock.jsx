import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Clock, LogIn, LogOut, Coffee, Play, MapPin, MapPinOff, AlertTriangle,
  CheckCircle, Loader2, Plus, X, CalendarDays,
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
  const [missed, setMissed] = useState({ kind: 'out', at: '', note: '' });
  const [, setTick] = useState(0);             // re-render for the live timer
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

  async function actualPunch(kind) {
    if (busy) return;
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
    } catch (e) { toast(false, e?.message || 'Punch failed.'); }
    setBusy('');
  }

  async function submitMissed() {
    if (!missed.at || !missed.note.trim()) { toast(false, 'Pick the time and add a short note.'); return; }
    try {
      const utc = new Date(missed.at).toISOString().slice(0, 19);
      await api.timeSelfPunch({ kind: missed.kind, at: utc,
        tz_offset_min: new Date().getTimezoneOffset(), note: missed.note.trim() });
      toast(true, 'Missed punch added — it will show as self-corrected for review.');
      setMissedOpen(false); setMissed({ kind: 'out', at: '', note: '' });
      load();
    } catch (e) { toast(false, e?.message || 'Could not add the punch.'); }
  }

  const last = status?.lastPunch;
  const clockedIn = last && last.kind !== 'out';
  const onBreak = last && last.kind === 'break_start';
  const sinceSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;
  const days = status?.days || {};
  const dayKeys = Object.keys(days).sort().reverse();

  const todayKey = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const todayData = days[todayKey];
  const weekTotal = Object.values(days).reduce((a, d) => a + d.workedMin, 0);
  const weekBreak = Object.values(days).reduce((a, d) => a + d.breakMin, 0);
  // Daily break allowance: 1 hour. Used = completed breaks today + the live open one.
  const BREAK_ALLOWANCE_MIN = 60;
  const breakUsedMin = (todayData?.breakMin || 0) + (onBreak ? Math.floor(sinceSec / 60) : 0);
  const breakLeftMin = BREAK_ALLOWANCE_MIN - breakUsedMin;
  const weekFlags = Object.values(days).reduce((a, d) => a + d.flags.length, 0);

  return (
    <div style={{ maxWidth: 1160, margin: '0 auto', padding: '26px 18px', fontFamily: 'Inter,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Clock size={20} style={{ color: 'var(--pine)' }} />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Time Clock</h1>
      </div>

      {/* Tabs — one job per screen (the everything-in-one page read as clutter) */}
      <div className="chip-row scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {[['clock', 'Clock'], ['timesheet', 'Timesheet'], ['timeoff', 'Time off']].map(([key, label]) => (
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
                  <button key={kind} onClick={() => doPunch(kind)} disabled={!!busy}
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
            <DayTimeline punches={todayData.punches} />
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
                <AlertTriangle size={11} /> {todayData.flags.length} item{todayData.flags.length === 1 ? '' : 's'} for review — see Timesheet
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
      </>)}

      {/* Timesheet — day list + week summary side panel */}
      {tab === 'timesheet' && (<>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1.9 1 480px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
        <CalendarDays size={15} style={{ color: 'var(--pine)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Last 7 days</span>
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
            <button className="primary-btn" onClick={submitMissed} style={{ fontSize: 12.5 }}>Add punch</button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)' }}>
            Self-added punches are marked for manager review. Anything older than 7 days needs a manager.
          </p>
        </div>
      )}

      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
        {dayKeys.length === 0 && (
          <div style={{ padding: '22px 18px', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
            No punches yet — your week shows up here.
          </div>
        )}
        {dayKeys.map(date => {
          const d = days[date];
          const isOpen = !!openDays[date];
          return (
            <div key={date} style={{ borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => setOpenDays(o => ({ ...o, [date]: !o[date] }))}
                style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                <span style={{ fontSize: 13, fontWeight: 800, width: 96, flexShrink: 0, color: 'var(--ink)' }}>
                  {new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
                <DayTimeline punches={d.punches} />
                {d.flags.length > 0 && <AlertTriangle size={13} style={{ color: '#b45309', flexShrink: 0 }} />}
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--pine)', width: 66, textAlign: 'right', flexShrink: 0 }}>{fmtMin(d.workedMin)}</span>
              </button>
              {isOpen && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 18px 12px 126px' }}>
                  {d.punches.map(p => {
                    const c = PUNCH_CHIP[p.kind] || PUNCH_CHIP.in;
                    return (
                      <span key={p.id} title={`${p.geoStatus}${p.workSiteName ? ' · ' + p.workSiteName : ''}${p.note ? ' · ' + p.note : ''}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
                          background: p.geoStatus === 'out_of_fence' ? 'rgba(180,83,9,0.12)' : c.bg,
                          color: p.geoStatus === 'out_of_fence' ? '#b45309' : c.fg,
                          border: p.source !== 'web' ? '1px dashed currentColor' : '1px solid transparent' }}>
                        {KIND_LABEL[p.kind]} {localTime(p.at)}
                        {p.geoStatus === 'in_fence' && <MapPin size={10} />}
                        {p.geoStatus === 'out_of_fence' && <AlertTriangle size={10} />}
                        {p.source !== 'web' && 'ⓜ'}
                      </span>
                    );
                  })}
                  {d.breakMin > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', alignSelf: 'center' }}>{d.breakMin}m break</span>}
                  {d.flags.includes('missing_out') && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', alignSelf: 'center' }}>· missing punch-out</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>
      <div style={{ flex: '1 1 280px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>Week summary</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {[['Worked', fmtMin(weekTotal), 'var(--pine)'],
            ['Breaks', `${weekBreak}m`, 'var(--ink)'],
            ['Days active', String(dayKeys.length), 'var(--ink)'],
            ['Items for review', String(weekFlags), weekFlags ? '#b45309' : 'var(--muted)']].map(([l, v, c]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{l}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: c }}>{v}</span>
            </div>
          ))}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          Click a day to see every punch. ⓜ marks manual entries, ⚠ marks anything a manager should look at.
        </p>
      </div>
      </div>
      </>)}

      {/* Time off */}
      {tab === 'timeoff' && (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
        <CalendarDays size={15} style={{ color: 'var(--pine)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Time off</span>
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
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', marginBottom: 24 }}>
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
    </div>
  );
}
