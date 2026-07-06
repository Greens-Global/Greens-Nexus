import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, LogOut, MonitorUp, MonitorX, Loader2 } from 'lucide-react';
import { api } from '../api';

// ── Global mini-timer — lives on EVERY screen while clocked in ────────────────
// A floating pill with a live HH:MM:SS stopwatch, a quick punch-out, and the
// work-session screen capture engine. Capture is consent-per-shift: the user
// explicitly picks their screen in the browser dialog (Chrome then shows a
// persistent "sharing" indicator — nothing is covert, matching monitoring-law
// transparency norms). While sharing, one frame is uploaded every 5 minutes
// with an idle-seconds reading; it all stops at punch-out or tab close.

const SHOT_EVERY_MS = 5 * 60 * 1000;

const fmtHMS = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export default function TimeclockWidget() {
  const [status, setStatus] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const shotTimer = useRef(null);
  const lastActive = useRef(Date.now());

  const load = useCallback(() => {
    api.timeStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nexus:timeclock-changed', onChange);
    const poll = setInterval(load, 120000);
    const sec = setInterval(() => setTick(t => t + 1), 1000);
    const bump = () => { lastActive.current = Date.now(); };
    window.addEventListener('pointermove', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.removeEventListener('nexus:timeclock-changed', onChange);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('keydown', bump);
      clearInterval(poll); clearInterval(sec);
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out');
  const onBreak = last?.kind === 'break_start';
  const elapsedSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;

  function stopCapture() {
    clearInterval(shotTimer.current);
    shotTimer.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCapturing(false);
  }

  // Capture stops the moment the shift ends (or the user revokes sharing).
  useEffect(() => { if (!clockedIn && capturing) stopCapture(); }, [clockedIn, capturing]);

  async function takeShot() {
    const stream = streamRef.current;
    if (!stream || !stream.active) { stopCapture(); return; }
    try {
      let video = videoRef.current;
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        videoRef.current = video;
      }
      video.srcObject = stream;
      await video.play();
      const scale = Math.min(1, 1280 / (video.videoWidth || 1280));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((video.videoWidth || 1280) * scale);
      canvas.height = Math.round((video.videoHeight || 720) * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.55));
      if (!blob) return;
      const form = new FormData();
      form.append('file', blob, 'shot.jpg');
      form.append('idle_sec', String(Math.round((Date.now() - lastActive.current) / 1000)));
      form.append('active_view', window.location.pathname.slice(0, 120));
      form.append('tz_offset_min', String(new Date().getTimezoneOffset()));
      await api.timeShotUpload(form);
    } catch { /* one failed frame never disturbs the session */ }
  }

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 1 }, audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
      setCapturing(true);
      takeShot(); // first frame right away, then every 5 minutes
      shotTimer.current = setInterval(takeShot, SHOT_EVERY_MS);
    } catch { /* user dismissed the picker — stays off */ }
  }

  async function quickPunchOut() {
    if (busy) return;
    setBusy(true);
    try {
      await api.timePunch({ kind: 'out', tz_offset_min: new Date().getTimezoneOffset() });
      stopCapture();
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
    } catch { /* the Time Clock page shows details */ }
    setBusy(false);
  }

  if (!clockedIn) return null;

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
      <button onClick={capturing ? stopCapture : startCapture}
        title={capturing ? 'Screen capture is ON — a frame is saved every 5 minutes. Click to stop.'
          : 'Start work-session screen capture (you pick the screen; your browser shows a sharing indicator the whole time)'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 999, cursor: 'pointer',
          border: capturing ? '1.5px solid #b91c1c' : '1.5px solid var(--line)',
          background: capturing ? 'rgba(220,38,38,0.08)' : 'transparent',
          color: capturing ? '#b91c1c' : 'var(--muted)', fontSize: 10.5, fontWeight: 800, fontFamily: 'Inter,sans-serif' }}>
        {capturing ? <MonitorUp size={12} /> : <MonitorX size={12} />} {capturing ? 'REC' : 'capture off'}
      </button>
      <button onClick={quickPunchOut} disabled={busy} title="Punch out"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: '50%',
          border: 'none', cursor: 'pointer', background: '#b91c1c', color: '#fff' }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LogOut size={13} />}
      </button>
    </div>
  );
}
