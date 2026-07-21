import { useState, useEffect, useCallback } from 'react';
import { Clock, LogOut, Loader2 } from 'lucide-react';
import { api } from '../api';
import BodModal from './BodModal';

// ── Global mini-timer — lives on EVERY screen while clocked in ────────────────
// A floating pill with a live HH:MM:SS stopwatch and a quick punch-out. Screen /
// activity monitoring is handled by the company's dedicated monitoring software
// (Flowace), NOT by Nexus — so there is no browser screen capture here (no
// picker, no sharing bar). Nexus owns the punch clock, payroll and approvals.

const fmtHMS = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export default function TimeclockWidget() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [eodOpen, setEodOpen] = useState(false);   // end-of-day message after punch-out
  const [, setTick] = useState(0);

  const load = useCallback(() => {
    api.timeStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nexus:timeclock-changed', onChange);
    const poll = setInterval(load, 120000);
    const sec = setInterval(() => setTick(t => t + 1), 1000);
    return () => {
      window.removeEventListener('nexus:timeclock-changed', onChange);
      clearInterval(poll); clearInterval(sec);
    };
  }, [load]);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out');
  const onBreak = last?.kind === 'break_start';
  const elapsedSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;

  async function quickPunchOut() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.timePunch({ kind: 'out', tz_offset_min: new Date().getTimezoneOffset() });
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      if (r?.promptEod) setEodOpen(true); // offer the end-of-day message
    } catch { /* the Time Clock page shows details */ }
    setBusy(false);
  }

  // Keep rendering while the EOD modal is up, even though the shift just ended.
  if (!clockedIn) {
    return eodOpen ? <BodModal mode="eod" onClose={() => setEodOpen(false)}
      toastOk={() => {}} toastErr={() => {}} /> : null;
  }

  return (
    <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 1190, display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '8px 10px 8px 14px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.18)', fontFamily: 'Inter,sans-serif' }}>
      <button onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock' } }))}
        title="Open Time Clock"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'Inter,sans-serif' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: onBreak ? '#b45309' : 'hsl(var(--color-green))',
          animation: onBreak ? 'none' : 'pulse 2s ease-in-out infinite' }} />
        <Clock size={14} style={{ color: onBreak ? '#b45309' : 'var(--pine)' }} />
        <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>
          {fmtHMS(elapsedSec)}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
          {onBreak ? 'break' : 'working'}
        </span>
      </button>
      <button onClick={quickPunchOut} disabled={busy} title="Punch out"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: '50%',
          border: 'none', cursor: 'pointer', background: '#b91c1c', color: '#fff' }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LogOut size={13} />}
      </button>
    </div>
  );
}
