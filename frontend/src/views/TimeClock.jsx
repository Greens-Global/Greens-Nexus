import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Clock, LogIn, LogOut, Coffee, Play, MapPin, MapPinOff, AlertTriangle,
  CheckCircle, Loader2, Plus, X, CalendarDays,
} from 'lucide-react';
import { api } from '../api';

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
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>
      <MapPinOff size={12} /> no location
    </span>);
}

export default function TimeClock() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);        // {ok, text}
  const [missedOpen, setMissedOpen] = useState(false);
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
    setBusy(kind);
    const pos = await getPosition();
    try {
      const r = await api.timePunch({
        kind, ...(pos || {}), tz_offset_min: new Date().getTimezoneOffset(),
      });
      const p = r.punch;
      const where = p.geoStatus === 'in_fence' ? ` at ${p.workSiteName}`
        : p.geoStatus === 'out_of_fence' ? ` — ${p.distanceM}m from ${p.workSiteName || 'the nearest site'}, flagged for review`
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

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '26px 18px', fontFamily: 'Inter,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Clock size={20} style={{ color: 'var(--pine)' }} />
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Time Clock</h1>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 12.5, color: 'var(--muted)' }}>
        Your location is captured only at the moment you punch, to confirm you're at a work site.
        If location is off or you're away from a site, the punch still counts — it's simply flagged for review.
      </p>

      {msg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, marginBottom: 14,
          background: msg.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: msg.ok ? 'hsl(var(--color-green))' : '#b91c1c', fontSize: 13, fontWeight: 600 }}>
          {msg.ok ? <CheckCircle size={15} /> : <AlertTriangle size={15} />} {msg.text}
        </div>
      )}

      {/* Punch card */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '26px 28px', marginBottom: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
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
            {last && <div style={{ marginBottom: 16 }}><GeoChip p={last} /></div>}
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

      {/* This week */}
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
          return (
            <div key={date} style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 800, width: 110 }}>
                  {new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {d.firstIn ? `${localTime(d.firstIn)} → ${d.lastOut ? localTime(d.lastOut) : '…'}` : '—'}
                </span>
                <div style={{ flex: 1 }} />
                {d.breakMin > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.breakMin}m break</span>}
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--pine)' }}>{fmtMin(d.workedMin)}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {d.punches.map(p => (
                  <span key={p.id} title={`${p.geoStatus}${p.workSiteName ? ' · ' + p.workSiteName : ''}${p.note ? ' · ' + p.note : ''}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
                      background: p.geoStatus === 'out_of_fence' ? 'rgba(180,83,9,0.1)' : 'var(--mist)',
                      color: p.geoStatus === 'out_of_fence' ? '#b45309' : 'var(--muted)',
                      border: p.source !== 'web' ? '1px dashed var(--line)' : '1px solid transparent' }}>
                    {KIND_LABEL[p.kind]} {localTime(p.at)}
                    {p.geoStatus === 'in_fence' && <MapPin size={10} />}
                    {p.geoStatus === 'out_of_fence' && <AlertTriangle size={10} />}
                    {p.source !== 'web' && 'ⓜ'}
                  </span>
                ))}
                {d.flags.includes('missing_out') && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309' }}>· missing punch-out</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Time off */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '22px 0 8px' }}>
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
    </div>
  );
}
