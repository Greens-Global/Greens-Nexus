import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, LogOut, MonitorUp, MonitorX, MonitorPause, Loader2, ChevronUp } from 'lucide-react';
import { api } from '../api';
import { editGuard } from '../asset/lib/editGuard.js';
import BodModal from './BodModal';
import { pollWhileVisible } from '../lib/pollWhileVisible';

// Whether a live desktop agent covers this PC is decided SERVER-SIDE and read from
// api.timeStatus().monitoring.agentActive - never by probing 127.0.0.1 from the
// page, which Chrome's private-network policy blocks on unmanaged browsers.

// ── Global mini-timer - lives on EVERY screen while clocked in ────────────────
// A floating pill with a live HH:MM:SS stopwatch, a quick punch-out, and the
// work-session screen capture engine. Capture is consent-per-shift: the user
// explicitly picks their screen in the browser dialog (Chrome then shows a
// persistent "sharing" indicator - nothing is covert, matching monitoring-law
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
  const [expanded, setExpanded] = useState(false); // capsule collapsed by default; expands upward
  const wrapRef = useRef(null);
  const [, setTick] = useState(0);
  const streamsRef = useRef([]);                   // one MediaStream per shared screen
  const videoRef = useRef(null);
  const lastShot = useRef(0);                       // wall-clock ms of the last frame
  const shotInFlight = useRef(false);
  const lastActive = useRef(Date.now());
  const gapRef = useRef(SHOT_EVERY_MS);             // base interval from policy (ms)
  const randomizeRef = useRef(false);              // jitter each gap ±25%?
  const nextGapRef = useRef(SHOT_EVERY_MS);        // the currently-scheduled gap (jittered)
  const onBreakRef = useRef(false);                // pause frames while on break
  const clockedInRef = useRef(false);              // only save frames during a live shift
  const canCaptureRef = useRef(false);             // monitoring policy allows capture
  const agentActiveRef = useRef(false);            // a live desktop agent covers this PC
  const startRef = useRef(null);                   // latest startCapture, for the global hook

  const load = useCallback(() => {
    api.timeStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nexus:timeclock-changed', onChange);
    // Poll fairly often so a punch/break on ANOTHER device reflects in this
    // widget's timer without a manual refresh (server holds the punch state).
    const stopPoll = pollWhileVisible(load, 25000);
    const sec = setInterval(() => setTick(t => t + 1), 1000);
    // Wall-clock scheduler: a frequent tick that fires a shot only once the full
    // interval has actually elapsed. Browsers throttle/freeze background-tab
    // timers, so a plain 5-min setInterval silently stops firing once the tab is
    // hidden - this catches up as soon as any tick lands or the tab refocuses.
    const due = setInterval(maybeShot, 20000);
    // On refocus: re-sync the punch state (a break on another device) AND catch
    // up a due screenshot.
    const onVis = () => { if (document.visibilityState === 'visible') { load(); maybeShot(); } };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    const bump = () => { lastActive.current = Date.now(); };
    window.addEventListener('pointermove', bump);
    window.addEventListener('keydown', bump);
    return () => {
      window.removeEventListener('nexus:timeclock-changed', onChange);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('keydown', bump);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      stopPoll(); clearInterval(sec); clearInterval(due);
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Collapse the expanded panel when clicking anywhere outside the widget.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setExpanded(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [expanded]);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out');
  const onBreak = last?.kind === 'break_start';
  const elapsedSec = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at + 'Z').getTime()) / 1000)) : 0;

  // Disclosed-monitoring policy drives whether capture is offered and its cadence.
  const mon = status?.monitoring;
  const canCapture = !!(mon?.enabled && mon?.trackScreens);
  // When the desktop agent covers this PC it does the capturing, so the browser's
  // capture control is irrelevant here - hide it (showing "Capture off" would read
  // as "nothing is recording" when the agent actually is).
  const agentActive = !!mon?.agentActive;
  const intervalMin = Math.max(1, mon?.intervalMinutes || 5);
  gapRef.current = intervalMin * 60 * 1000;
  randomizeRef.current = !!mon?.randomize;
  // Keep the capture loop's refs in sync with the live punch state each render.
  onBreakRef.current = onBreak;
  clockedInRef.current = clockedIn;
  canCaptureRef.current = canCapture;
  agentActiveRef.current = !!mon?.agentActive;   // server says a live agent covers this person's PC
  // Next gap until a shot is due - jittered ±25% when the policy randomizes.
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

  // Capture tears down on the clocked-in → clocked-out TRANSITION (a real
  // punch-out), not on the static !clockedIn condition - otherwise the stream we
  // pre-acquire on the punch-in click (while last.kind is still 'out') would be
  // killed before the punch lands. Policy turning off also stops it immediately.
  const wasClockedIn = useRef(false);
  useEffect(() => {
    if (wasClockedIn.current && !clockedIn && capturing) stopCapture();  // shift ended
    wasClockedIn.current = clockedIn;
  }, [clockedIn, capturing]);
  useEffect(() => { if (!canCapture && capturing) stopCapture(); }, [canCapture, capturing]);

  // Expose the engine globally so the punch-in button (in the Time Clock view)
  // can start capture from within its own click - the browser only grants screen
  // sharing on a user gesture, so an effect/state-change can't start it silently.
  startRef.current = startCapture;
  useEffect(() => {
    window.__nexusCapture = {
      // Resolves true when a screen stream is live OR capture isn't required here
      // (policy off, monitoring-exempt, or the device CAN'T screen-share); false
      // only when a share IS required, the device supports it, and the employee
      // dismissed the browser's picker. The punch button awaits this to enforce
      // share-to-clock-in for non-exempt staff on capable devices.
      start: async () => {
        if (streamsRef.current.length) return true;   // already sharing
        if (!canCaptureRef.current) return true;      // not required for this person
        // Mobile/tablet browsers have no getDisplayMedia - you can't screen-monitor
        // a phone. Never block a field worker's punch on a share they physically
        // cannot perform; the punch records normally (monitoring simply n/a here).
        if (!navigator.mediaDevices?.getDisplayMedia) return true;
        // A live desktop agent covers this PC (server-detected via the assigned
        // device's heartbeat)? Then it captures every monitor natively - skip the
        // browser share (no picker, no double capture). Re-check FRESH at click
        // time (not the 25s-poll cache) so a PC assigned an owner moments ago is
        // honored immediately - the employee never has to reload the page.
        let covered = agentActiveRef.current;
        try {
          const s = await api.timeStatus();
          if (s?.monitoring) { covered = !!s.monitoring.agentActive; agentActiveRef.current = covered; }
        } catch { /* server unreachable - fall back to the last known value */ }
        if (covered) return true;
        await startRef.current?.();
        return streamsRef.current.length > 0;
      },
      stop: stopCapture,
      // Only "required" on a device that can actually screen-share.
      required: () => canCaptureRef.current && !!navigator.mediaDevices?.getDisplayMedia,
    };
    return () => { if (window.__nexusCapture) delete window.__nexusCapture; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fire a shot only when the scheduled gap has really elapsed (wall-clock guard
  // against throttled/coalesced background timers) and none is already running.
  // Frames pause on break and never save off-shift; the stream stays live across
  // a break so ending it resumes capture with no second sharing prompt.
  function maybeShot() {
    if (!streamsRef.current.length || shotInFlight.current) return;
    if (onBreakRef.current || !clockedInRef.current) return;
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
        // Label browser-share frames "Chrome share" (mirrors the desktop agent's
        // "desktop agent · screen N") instead of leaking the current page path.
        form.append('active_view', 'Chrome share'
          + (streamsRef.current.length > 1 ? ` · screen ${i + 1}` : ''));
        form.append('tz_offset_min', String(new Date().getTimezoneOffset()));
        await api.timeShotUpload(form);
      } catch { /* one failed frame never disturbs the session */ }
    }
    } finally { shotInFlight.current = false; }
  }

  function addStream(stream) {
    streamsRef.current = [...streamsRef.current, stream];
    stream.getVideoTracks()[0]?.addEventListener('ended', () => dropStream(stream));
  }

  async function startCapture() {
    if (!canCaptureRef.current) return;   // monitoring policy off - nothing to do
    if (agentActiveRef.current) return;   // the desktop agent captures here instead
    // Managed-device path: getAllScreensMedia() grabs EVERY monitor at once with
    // NO picker - but only when the Nexus origin is allowlisted by the managed-
    // Chrome policy MultiScreenCaptureAllowedForUrls. On any device without that
    // policy the API is absent (or throws), so we fall through to the standard
    // one-screen picker below. This is what makes capture fully automatic on
    // company devices while staying honest (nothing silent on personal machines).
    if (typeof navigator.mediaDevices.getAllScreensMedia === 'function') {
      try {
        const result = await navigator.mediaDevices.getAllScreensMedia();
        const streams = Array.isArray(result) ? result : [result];
        streams.filter(Boolean).forEach(addStream);
        if (streamsRef.current.length) {
          setCapturing(streamsRef.current.length);
          takeShot();
          return;
        }
      } catch { /* not policy-allowlisted here - use the picker */ }
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 1 }, audio: false,
      });
      addStream(stream);
      setCapturing(streamsRef.current.length);
      takeShot(); // first frame right away; the wall-clock ticker handles the rest
    } catch { /* user dismissed the picker - stays off */ }
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

  // Capture chip state, shared by the expanded panel and the collapsed capsule's
  // mini indicator. Break must read PAUSED, not REC, so it's obvious capture
  // stopped for the break.
  const paused = capturing > 0 && onBreak;
  const capTint = paused ? '#b45309' : capturing ? '#b91c1c' : 'var(--muted)';

  // Lift the capsule clear of any bottom save bar (asset detail edit) so the
  // Save/Discard buttons underneath are never covered. editGuard.dirty is the
  // same flag that save bar renders from, and this component re-renders every
  // second, so the offset tracks it closely enough.
  const bottom = editGuard.dirty ? 88 : 18;

  return (
    <div ref={wrapRef} style={{ position: 'fixed', bottom, right: 18, zIndex: 1190, display: 'flex',
      flexDirection: 'column', alignItems: 'flex-end', gap: 8, fontFamily: 'var(--wk-font)', transition: 'bottom .18s ease' }}>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, minWidth: 232,
          background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '14px 16px',
          boxShadow: '0 24px 70px rgba(17,24,39,0.30)' }}>
          {/* Timer row - click opens the Time Clock page (matches the hero's anatomy). */}
          <button onClick={() => { window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock' } })); setExpanded(false); }}
            title="Open Time Clock"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'var(--wk-font)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
              background: onBreak ? '#b45309' : 'var(--wk-brand)',
              animation: onBreak ? 'none' : 'pulse 2s ease-in-out infinite' }} />
            <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: onBreak ? '#b45309' : 'var(--wk-brand)', lineHeight: 1 }}>
              {fmtHMS(elapsedSec)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
              {onBreak ? 'On Break' : 'Working'}
            </span>
          </button>
          {/* Capture control appears only when the BROWSER is the capturer: policy
              enables screens AND no desktop agent covers this PC. */}
          {canCapture && !agentActive && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={capturing ? stopCapture : startCapture}
                title={paused ? 'Screen capture is paused for your break - no frames are saved until you end the break. Click to stop capture entirely.'
                  : capturing ? `Screen capture is on (${capturing} screen${capturing === 1 ? '' : 's'}) - a frame of each is saved every ${intervalMin} minute${intervalMin === 1 ? '' : 's'}${randomizeRef.current ? ' (timing varies)' : ''}. Click to stop.`
                  : 'Start work-session screen capture (you pick the screen; your browser shows a sharing indicator the whole time)'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${capturing ? 'transparent' : 'var(--wk-line2)'}`,
                  background: paused ? 'rgba(180,83,9,0.1)' : capturing ? 'rgba(220,38,38,0.08)' : 'transparent',
                  color: capTint, fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>
                {paused ? <MonitorPause size={12} /> : capturing ? <MonitorUp size={12} /> : <MonitorX size={12} />}
                {paused ? 'Paused for break' : capturing ? `Recording${capturing > 1 ? ` · ${capturing} screens` : ''}` : 'Capture off'}
              </button>
              {capturing > 0 && (
                <button onClick={startCapture} title="Also capture another screen (pick your second monitor)"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', cursor: 'pointer',
                    border: '1px solid var(--wk-line2)', background: 'transparent', color: 'var(--muted)', fontSize: 14, fontWeight: 700, fontFamily: 'var(--wk-font)', padding: 0 }}>
                  +
                </button>
              )}
            </div>
          )}
          <button onClick={quickPunchOut} disabled={busy} title="Punch out"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 12px', borderRadius: 10,
              border: 'none', cursor: 'pointer', background: '#b91c1c', color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LogOut size={13} />}
            Punch out
          </button>
        </div>
      )}

      {/* Collapsed capsule - small on purpose so it never buries page-level bars
          (e.g. the asset "Save before you leave" bar). Click to expand upward. */}
      <button onClick={() => setExpanded(v => !v)}
        title={expanded ? 'Collapse' : 'Time clock - click for controls'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--card)', border: '1px solid var(--wk-line2)',
          borderRadius: 999, padding: '7px 11px 7px 13px', boxShadow: '0 6px 22px rgba(17,24,39,0.16)', cursor: 'pointer', fontFamily: 'var(--wk-font)' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: onBreak ? '#b45309' : 'var(--wk-brand)',
          animation: onBreak ? 'none' : 'pulse 2s ease-in-out infinite' }} />
        <span style={{ fontSize: 13.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--ink)' }}>
          {fmtHMS(elapsedSec)}
        </span>
        {/* Browser capture indicator (only when the browser is the capturer). */}
        {canCapture && !agentActive && capturing > 0 && (paused ? <MonitorPause size={12} style={{ color: capTint }} /> : <MonitorUp size={12} style={{ color: capTint }} />)}
        <ChevronUp size={13} style={{ color: 'var(--muted)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
    </div>
  );
}
