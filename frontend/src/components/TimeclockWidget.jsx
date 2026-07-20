import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, LogOut, MonitorUp, MonitorX, Loader2 } from 'lucide-react';
import { api } from '../api';
import BodModal from './BodModal';

// ── Global mini-timer — lives on EVERY screen while clocked in ────────────────
// A floating pill with a live HH:MM:SS stopwatch, a quick punch-out, and the
// work-session screen capture engine. Capture is consent-per-shift: the user
// explicitly picks their screen in the browser dialog (Chrome then shows a
// persistent "sharing" indicator — nothing is covert, matching monitoring-law
// transparency norms). While sharing, one frame is uploaded per interval with an
// idle-seconds reading; it all stops at punch-out or tab close.
//
// Disclosed-monitoring: the capture control is only offered when the admin
// monitoring policy has both `enabled` and `trackScreens` on. Cadence follows
// `intervalMinutes`, and when `randomize` is set each gap is jittered ±25% so the
// exact capture moment can't be predicted (read from api.timeStatus().monitoring).

const SHOT_EVERY_MS = 5 * 60 * 1000;   // fallback until policy loads

const fmtHMS = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export default function TimeclockWidget() {
  const [status, setStatus] = useState(null);
  const [capturing, setCapturing] = useState(0);   // number of screens being captured
  const [busy, setBusy] = useState(false);
  const [eodOpen, setEodOpen] = useState(false);   // end-of-day message after punch-out
  const [, setTick] = useState(0);
  const streamsRef = useRef([]);                   // one MediaStream per shared screen
  const videoRef = useRef(null);
  const lastShot = useRef(0);                       // wall-clock ms of the last frame
  const shotInFlight = useRef(false);
  const lastActive = useRef(Date.now());
  const gapRef = useRef(SHOT_EVERY_MS);             // base interval from policy (ms)
  const randomizeRef = useRef(false);              // jitter each gap ±25%?
  const nextGapRef = useRef(SHOT_EVERY_MS);        // the currently-scheduled gap (jittered)

  const load = useCallback(() => {
    api.timeStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nexus:timeclock-changed', onChange);
    const poll = setInterval(load, 120000);
    const sec = setInterval(() => setTick(t => t + 1), 1000);
    // Wall-clock scheduler: a frequent tick that fires a shot only once the full
    // interval has actually elapsed. Browsers throttle/freeze background-tab
    // timers, so a plain 5-min setInterval silently stops firing once the tab is
    // hidden — this catches up as soon as any tick lands or the tab refocuses.
    const due = setInterval(maybeShot, 20000);
    const onVis = () => { if (document.visibilityState === 'visible') maybeShot(); };
    document.addEventListener('visibilitychange', onVis);
    const bump = () => { lastActive.current = Date.now(); };
    window.addEventListener('pointermove', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.removeEventListener('nexus:timeclock-changed', onChange);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('keydown', bump);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(poll); clearInterval(sec); clearInterval(due);
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out');
  const onBreak = last?.kind === 'break_start';
  const elapsedSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;

  // Disclosed-monitoring policy drives whether capture is offered and its cadence.
  const mon = status?.monitoring;
  const canCapture = !!(mon?.enabled && mon?.trackScreens);
  const intervalMin = Math.max(1, mon?.intervalMinutes || 5);
  gapRef.current = intervalMin * 60 * 1000;
  randomizeRef.current = !!mon?.randomize;
  // Next gap until a shot is due — jittered ±25% when the policy randomizes.
  const nextGap = () => randomizeRef.current
    ? Math.round(gapRef.current * (0.75 + Math.random() * 0.5))
    : gapRef.current;

  function dropStream(stream) {
    stream.getTracks().forEach(t => t.stop());
    streamsRef.current = streamsRef.current.filter(s => s !== stream);
    setCapturing(streamsRef.current.length);
  }

  function stopCapture() {
    [...streamsRef.current].forEach(dropStream);
  }

  // Capture stops the moment the shift ends, the policy turns screen tracking
  // off, or the user revokes sharing.
  useEffect(() => { if ((!clockedIn || !canCapture) && capturing) stopCapture(); }, [clockedIn, canCapture, capturing]);

  // Fire a shot only when the scheduled gap has really elapsed (wall-clock guard
  // against throttled/coalesced background timers) and none is already running.
  function maybeShot() {
    if (!streamsRef.current.length || shotInFlight.current) return;
    if (Date.now() - lastShot.current >= nextGapRef.current) takeShot();
  }

  async function takeShot() {
    if (shotInFlight.current) return;
    shotInFlight.current = true;
    lastShot.current = Date.now();
    nextGapRef.current = nextGap();   // schedule the next (possibly jittered) gap
    // Snapshot EVERY shared screen (multi-monitor: one stream per screen)
    try {
    for (let i = 0; i < streamsRef.current.length; i++) {
      const stream = streamsRef.current[i];
      if (!stream.active) { dropStream(stream); continue; }
      try {
        let video = videoRef.current;
        if (!video) {
          video = document.createElement('video');
          video.muted = true;
          videoRef.current = video;
        }
        video.srcObject = stream;
        await video.play();
        // Keep full resolution up to 1920px wide so screen text stays legible;
        // only downscale genuinely huge (4K/ultrawide) monitors.
        const scale = Math.min(1, 1920 / (video.videoWidth || 1920));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((video.videoWidth || 1920) * scale);
        canvas.height = Math.round((video.videoHeight || 1080) * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (!blob) continue;
        const form = new FormData();
        form.append('file', blob, 'shot.jpg');
        form.append('idle_sec', String(Math.round((Date.now() - lastActive.current) / 1000)));
        form.append('active_view', window.location.pathname.slice(0, 100)
          + (streamsRef.current.length > 1 ? ` · screen ${i + 1}` : ''));
        form.append('tz_offset_min', String(new Date().getTimezoneOffset()));
        await api.timeShotUpload(form);
      } catch { /* one failed frame never disturbs the session */ }
    }
    } finally { shotInFlight.current = false; }
  }

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 1 }, audio: false,
      });
      streamsRef.current = [...streamsRef.current, stream];
      stream.getVideoTracks()[0].addEventListener('ended', () => dropStream(stream));
      setCapturing(streamsRef.current.length);
      takeShot(); // first frame right away; the wall-clock ticker handles the rest
    } catch { /* user dismissed the picker — stays off */ }
  }

  async function quickPunchOut() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.timePunch({ kind: 'out', tz_offset_min: new Date().getTimezoneOffset() });
      stopCapture();
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
      {/* Disclosed-monitoring: capture control only appears when the policy enables screen tracking. */}
      {canCapture && (
      <button onClick={capturing ? stopCapture : startCapture}
        title={capturing ? `Screen capture is ON (${capturing} screen${capturing === 1 ? '' : 's'}) — a frame of each is saved every ${intervalMin} minute${intervalMin === 1 ? '' : 's'}${randomizeRef.current ? ' (timing varies)' : ''}. Click to stop.`
          : 'Start work-session screen capture (you pick the screen; your browser shows a sharing indicator the whole time)'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 999, cursor: 'pointer',
          border: capturing ? '1.5px solid #b91c1c' : '1.5px solid var(--line)',
          background: capturing ? 'rgba(220,38,38,0.08)' : 'transparent',
          color: capturing ? '#b91c1c' : 'var(--muted)', fontSize: 10.5, fontWeight: 800, fontFamily: 'Inter,sans-serif' }}>
        {capturing ? <MonitorUp size={12} /> : <MonitorX size={12} />} {capturing ? `REC${capturing > 1 ? ` ×${capturing}` : ''}` : 'capture off'}
      </button>
      )}
      {canCapture && capturing > 0 && (
        <button onClick={startCapture} title="Also capture another screen (pick your second monitor)"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', cursor: 'pointer',
            border: '1.5px solid var(--line)', background: 'transparent', color: 'var(--muted)', fontSize: 13, fontWeight: 800, fontFamily: 'Inter,sans-serif', padding: 0 }}>
          +
        </button>
      )}
      <button onClick={quickPunchOut} disabled={busy} title="Punch out"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: '50%',
          border: 'none', cursor: 'pointer', background: '#b91c1c', color: '#fff' }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LogOut size={13} />}
      </button>
    </div>
  );
}
