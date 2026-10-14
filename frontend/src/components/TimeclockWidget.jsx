import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronUp } from 'lucide-react';
import { api } from '../api';
import { editGuard } from '../asset/lib/editGuard.js';
import BodModal from './BodModal';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { useTimeStatus, applyPunch } from '../lib/useTimeStatus';
import { punchDurable, replayPending, readPending } from '../lib/punchQueue';
import { punchPosition, keepPositionWarm } from '../lib/geoPosition';
import { replayPendingBods } from '../lib/bodQueue';
import { useRole } from '../contexts/RoleContext';
import { rememberTimeExempt } from '../lib/timeTracking';
import { publishTimeclock, useTimeclockClaimed, fmtHM, openTimeClock } from '../lib/timeclockStore';
import { deriveMyTime, localKey } from '../dashboard/essentials/usePunchClock.jsx';
import ClockChip, { ClockRing } from './ClockChip';

// Whether a desktop agent covers THIS machine is detected per-machine by asking
// the local agent directly over localhost. The agent serves a no-side-effect
// liveness probe (GET 127.0.0.1:47615/nexus/ping) with an
// Access-Control-Allow-Private-Network header, so this works under Chrome's
// private-network policy - the same channel clock-in already uses to pair. The
// server's own agentActive (keyed on the bound session) is only a mirror; owning
// an agent PC somewhere is NOT the same as sitting at it, which is why the
// per-machine probe is the authority for whether the browser must screen-share.
const NEXUS_AGENT_PORT = 47615;
async function _localAgentPresent() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(`http://127.0.0.1:${NEXUS_AGENT_PORT}/nexus/ping`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;   // refused / blocked / timed out - no agent on this machine
  }
}

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

export default function TimeclockWidget() {
  // The shared read (lib/useTimeStatus): this widget, Workday and the dashboard
  // tiles are one request per poll. 25s so a punch/break on ANOTHER device
  // reflects in this widget's timer without a manual refresh.
  const { status, reload: reloadStatus } = useTimeStatus({ pollMs: 25000 });
  // A page surface (the sidebar chip) is drawing the clock: this stays the
  // engine and draws nothing itself but its modals (lib/timeclockStore.js).
  const claimed = useTimeclockClaimed();
  // `|| {}`: null outside RoleProvider (render tests).
  const { myEmail = '' } = useRole() || {};
  // This widget is mounted app-wide and asks /time/status first, so it is the
  // one that usually teaches the browser whether this person is time-tracking
  // exempt - Workday then opens without a clock skeleton (Neil, 10/08).
  useEffect(() => {
    if (status && typeof status.timeTrackingExempt === 'boolean') rememberTimeExempt(myEmail, status.timeTrackingExempt);
  }, [status, myEmail]);
  const [capturing, setCapturing] = useState(0);   // number of screens being captured
  const [busy, setBusy] = useState(false);
  const [eodOpen, setEodOpen] = useState(false);   // end-of-day message after punch-out
  const [lostOut, setLostOut] = useState(false);   // the quick punch-out did not record
  const [expanded, setExpanded] = useState(false); // capsule collapsed by default; expands upward
  const [localAgent, setLocalAgent] = useState(false); // /nexus/ping answered on THIS machine
  const [agentProbed, setAgentProbed] = useState(false); // ...and the first probe has answered at all
  // Today's scheduled minutes from Shifts, for the dial's target (Neil, Oct
  // 14 2026: a 4-hour shift fills the ring at 4 hours; no shift = 8h).
  // Read once per local day while clocked in.
  const [shiftMin, setShiftMin] = useState(null);
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
    reloadStatus();
    // Per-machine truth for the capture UI, not just the capture engine: the
    // server's agentActive only turns true once the agent BINDS this person's
    // session, so a running-but-unbound agent otherwise leaves a misleading
    // "Capture off" pill on screen while the agent is in fact recording
    // (Aarav, Sep 3). Cheap: an absent agent refuses instantly, a blocked one
    // times out in 1.2s, and this rides the existing 25s status poll.
    _localAgentPresent().then((v) => { setLocalAgent(v); setAgentProbed(true); }).catch(() => setAgentProbed(true));
  }, [reloadStatus]);

  // The mini-timer is mounted on every screen, so this is where a punch parked
  // by a dead connection gets its app-wide second chance - the person does not
  // have to find their way back to the Time Clock page for it to land.
  useEffect(() => {
    // Same app-wide second chance for a day message parked by bodQueue.js.
    replayPendingBods().catch(() => {});
    if (!readPending()) return;
    replayPending().then(r => { if (r?.restored || r?.dropped) load(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('nexus:timeclock-changed', onChange);
    // The status itself is polled by useTimeStatus; this keeps the local-agent
    // probe on the same 25s pace it always rode.
    const stopPoll = pollWhileVisible(() => { _localAgentPresent().then(setLocalAgent).catch(() => {}); }, 25000);
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
  // A clock-in older than 16 hours is a stale open shift: the server treats it
  // as closed (Punch Out is refused, the timesheet shows Missing), so this
  // capsule must not keep counting to 88 hours with a Punch Out button the
  // server will bounce (Neil, Sep 9). Same rule as the clock page.
  const clockedIn = !!(last && last.kind !== 'out') && !status?.staleOpenShift;
  const onBreak = clockedIn && last?.kind === 'break_start';
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
  agentActiveRef.current = !!mon?.agentActive || localAgent;   // server-bound OR probed right here
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
  // A recent location on hand for the clock-out (Amy, Sep 29): a desktop's
  // fix is often slower than the out-punch's short wait.
  useEffect(() => (clockedIn ? keepPositionWarm() : undefined), [clockedIn]);

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
        // Is a desktop agent running on THIS machine? Ask it directly over
        // localhost (the same channel clock-in pairs on) - the agent answers
        // /nexus/ping with a Private-Network CORS header, so this works even
        // under Chrome's private-network policy. A reachable agent captures every
        // monitor natively, so the browser skips its own share (no picker, no
        // double capture).
        //
        // This is PER MACHINE, unlike the old server `agentActive`, which said
        // "covered" whenever the person OWNED an agent PC anywhere - so someone
        // who owns an agent at their desk but is working today on a different,
        // agent-less computer got no share option and that machine went
        // uncaptured (Visesh, Aug 26). The probe only sees an agent that is
        // actually here. BOUNDED (getDisplayMedia needs the click's ~5s
        // transient activation): a missing agent refuses instantly, a blocked
        // one times out in 1.2s, then the browser shares.
        if (await _localAgentPresent()) { agentActiveRef.current = true; return true; }
        agentActiveRef.current = false;
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

  // Start / end a break right here (Neil, Sep 23) - the same durable punch
  // the clock page makes, without a trip to it. The capture engine already
  // pauses frames while on break (see onBreakRef).
  const [breakBusy, setBreakBusy] = useState(false);
  // A one-line note for the surfaces (why a tap did nothing), cleared after
  // a moment; the timer is held in a ref so an unmount never sets state.
  const [note, setNote] = useState('');
  const noteTimer = useRef(null);
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const say = (text) => { setNote(text); clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNote(''), 6000); };
  // 'break' / 'break_end' while the reason / note prompt holds the punch, and
  // the moment the button was pressed, so the server backdates the punch to
  // it (bounded to 15 minutes) - the Time Clock screen's own order.
  const [breakGate, setBreakGate] = useState(null);
  const breakClickRef = useRef('');
  const breakPosRef = useRef(null);   // the location fix, started as the prompt opens
  // The shift closed under an open prompt (punched out on another device, a
  // stale shift): drop it right here in the render, or the chip stays
  // disabled and the prompt comes back on the next shift.
  if (!clockedIn && (breakGate || breakBusy)) { setBreakGate(null); setBreakBusy(false); breakClickRef.current = ''; }
  async function quickBreak(kind) {
    if (busy || breakBusy) return false;   // a sheet must not close on a tap that did nothing
    setBreakBusy(true);
    // Coming back from a break needs the screen shared where the policy
    // requires it (same rule as the Workday page and the Punch tile): the
    // browser only grants a share on a user gesture, so it starts here,
    // inside the tap, and a declined picker blocks the punch.
    if (kind === 'break_end') {
      let ok;
      try { ok = await (window.__nexusCapture?.start?.() ?? Promise.resolve(true)); } catch { ok = false; }
      if (!ok) {
        say('Share your screen to end your break - choose a screen when your browser asks, then tap again.');
        setBreakBusy(false);
        return false;
      }
    }
    // A break asks for its reason on the way out and offers a note on the way
    // back, posted to the person's chat (BodModal) - the same prompts the Time
    // Clock screen holds the punch behind; the sidebar chip skipped them (Neil,
    // Oct 14 2026). The punch records once the message is sent; closing the
    // prompt cancels it. Role-flagged people (bodExempt: field workers who
    // cannot type) punch straight through.
    if (!status?.bodExempt) {
      breakClickRef.current = new Date().toISOString().slice(0, 19);
      breakPosRef.current = punchPosition(kind);   // runs while they type
      setBreakGate(kind === 'break_start' ? 'break' : 'break_end');
      return true;   // the sheet may close - the prompt stands on its own
    }
    return finishBreak(kind);
  }
  async function finishBreak(kind) {
    // With a position, like the Time Clock page - without one every break
    // from here read "Location off" on the timecard (Charmi, Sep 29).
    const pos = (await (breakPosRef.current || punchPosition(kind))) ?? await punchPosition(kind);   // a miss asks once more, as before
    breakPosRef.current = null;
    const res = await punchDurable({ kind, tzOffsetMin: new Date().getTimezoneOffset(), pos, clickedAt: breakClickRef.current || undefined });
    if (res.ok) {
      breakClickRef.current = '';
      setLostOut(false);
      applyPunch(res.punch);   // the chip flips now; the re-read confirms
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
    } else if (res.unreachable) {
      setLostOut(true);
      setExpanded(true);
    }
    setBreakBusy(false);
    return !!res.ok;
  }

  async function quickPunchOut() {
    if (busy) return false;
    setBusy(true);
    // An earlier punch is still owed (a break end that never landed). Send THAT
    // first: punching out moves the state past it, after which it can never be
    // placed and would be dropped silently - turning a five-minute problem into
    // an afternoon of unpaid break. If it still won't go, don't end the day.
    const held = readPending();
    if (held) {
      const r = await replayPending();
      if (!r?.restored && !r?.dropped) {
        setLostOut(true); setExpanded(true); setBusy(false);
        return false;
      }
      load();
    }
    // Durable: a dropped punch-out used to be swallowed here entirely, leaving
    // the shift open with nobody told. Now it retries, parks for replay, and -
    // since this capsule is the only surface the person is looking at - says so.
    const pos = await punchPosition('out');   // short budget: the punch landing comes first
    const res = await punchDurable({ kind: 'out', tzOffsetMin: new Date().getTimezoneOffset(), pos });
    if (res.ok) {
      setLostOut(false);
      stopCapture();
      applyPunch(res.punch);
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      if (res.result?.promptEod) setEodOpen(true); // offer the end-of-day message
    } else if (res.unreachable) {
      setLostOut(true);
      setExpanded(true);   // never leave this hiding inside a collapsed capsule
    }
    setBusy(false);
    return !!res.ok;
  }

  // ── The view-model every surface draws (sidebar chip, phone capsule) ──
  // Hours are the Punch tile's numbers (deriveMyTime): today's worked minutes
  // while working, the break so far while on one - as H:MM, no seconds
  // (Neil, Oct 14 2026). Actions are this engine's own.
  // One derivation of the shift (deriveMyTime - the Punch tile's): its
  // state is the chip's state; this widget's own elapsedSec is only the
  // break timer.
  const mine = deriveMyTime({ status, now: new Date() });
  const live = mine.state === 'in' || mine.state === 'break';
  // Monitoring on the chip only when the browser is the capturer (policy
  // on, no desktop agent): the screens being captured, paused on a break,
  // and `needed` when the share the policy requires has dropped mid-shift
  // (the browser's own Stop sharing, a page reload).
  // Not before the local-agent probe has answered: until then an agent PC
  // would show a dropped-share alert for a share it never needed.
  const browserCaptures = canCapture && !agentActive && !localAgent && agentProbed && !!navigator.mediaDevices?.getDisplayMedia;
  // A second monitor the browser can see but is not sharing: `screen.isExtended`
  // says the display is extended (no permission needed), so one shared stream
  // on an extended display means a screen is going uncaptured.
  const expectedScreens = (typeof window !== 'undefined' && window.screen?.isExtended === true) ? 2 : 1;
  // Off the clock the line reads like the live one ("since 4:30 PM"), never
  // a sentence that has to be cropped; nothing yet today reads as such.
  const offSince = mine.lastOutLabel.startsWith('Last clocked out at ') ? mine.lastOutLabel.replace('Last clocked out at ', 'since ') : mine.lastOutLabel;
  const vm = !live ? { state: mine.state, sinceLabel: offSince } : {
    state: mine.state,
    timer: fmtHM(onBreak ? Math.floor(elapsedSec / 60) : mine.todayMin),
    todayMin: mine.todayMin,
    targetMin: shiftMin || 480,
    sinceLabel: mine.sinceLabel,
    lost: lostOut, note, busy, breakBusy,
    capture: browserCaptures ? {
      screens: capturing, expected: Math.max(expectedScreens, capturing),
      paused: capturing > 0 && onBreak, needed: capturing === 0 && !onBreak,
      missing: capturing > 0 && capturing < expectedScreens && !onBreak,
      intervalMin, randomize: randomizeRef.current,
    } : null,
    actions: {
      toggleBreak: () => quickBreak(onBreak ? 'break_end' : 'break_start'),
      punchOut: quickPunchOut,
      startCapture: () => startCapture(),
      stopCapture,
      openClock: openTimeClock,
    },
  };
  useEffect(() => { publishTimeclock(vm); });
  // Unmounted (a boundary reset, sign-out): the surfaces must not keep
  // drawing a shift whose actions belong to a dead instance.
  useEffect(() => () => publishTimeclock({ state: 'unknown' }), []);
  const todayLocal = localKey(new Date());
  useEffect(() => {
    if (!live) return undefined;
    let alive = true;
    api.timeMySchedule(todayLocal, todayLocal)
      .then((r) => {
        if (!alive) return;
        // The server's paid minutes per placed shift (unpaid break out,
        // overnight handled); a weather-cancelled shift does not count.
        const total = (r?.scheduled || []).filter((x) => x.weatherStatus !== 'cancelled').reduce((sum, x) => sum + (Number(x.paidMin) || 0), 0);
        setShiftMin(total > 0 ? total : null);
      })
      .catch(() => { if (alive) setShiftMin(null); });
    return () => { alive = false; };
  }, [live, todayLocal]);

  // The break prompt, drawn whichever surface holds the shift (the sidebar
  // chip, the capsule, the phone sheet): a sent message lands the punch, the
  // X cancels it and frees the button. The modal's own complaints ("Add a
  // short reason.") go to the chip's note line.
  const breakModal = breakGate ? (
    <BodModal mode={breakGate} required
      onSent={() => { const kind = breakGate === 'break' ? 'break_start' : 'break_end'; setBreakGate(null); finishBreak(kind); }}
      onClose={() => { breakClickRef.current = ''; breakPosRef.current = null; setBreakGate(null); setBreakBusy(false); }}
      toastOk={() => {}} toastErr={say} />
  ) : null;

  // Salaried/exempt people are never time-tracked - no floating timer for them
  // (Charmi, Aug 21).
  if (status?.timeTrackingExempt) return null;
  // Keep rendering while the EOD modal is up, even though the shift just ended.
  if (!clockedIn) {
    return eodOpen ? <BodModal mode="eod" onClose={() => setEodOpen(false)}
      toastOk={() => {}} toastErr={() => {}} /> : null;
  }
  // The sidebar chip is on screen: it draws the shift, this engine keeps
  // running underneath (capture, replay, polling) with nothing to show.
  if (claimed) return breakModal;

  // Lift the capsule clear of any bottom save bar (asset detail edit) so the
  // Save/Discard buttons underneath are never covered. editGuard.dirty is the
  // same flag that save bar renders from, and this component re-renders every
  // second, so the offset tracks it closely enough.
  const bottom = editGuard.dirty ? 88 : 18;
  // Back to the plain corner (Neil, Sep 21: the AI Assistant bubble - the
  // thing this used to dodge - is hidden for now, see ASSISTANT_ENABLED in
  // AssistantWidget.jsx). Re-apply the clearance offset alongside re-enabling
  // that flag if the Assistant comes back.
  const right = 18;

  // The phone capsule (no sidebar below 900px): a small pill with the live
  // dot and the hours; tap it and the same chip the sidebar draws opens
  // above it. Small on purpose so it never buries page-level bars (e.g. the
  // asset "Save before you leave" bar).
  return (<>
    {breakModal}
    <div ref={wrapRef} className="tc-capsule" style={{ position: 'fixed', bottom, right, zIndex: 1190, display: 'flex',
      flexDirection: 'column', alignItems: 'flex-end', gap: 8, fontFamily: 'var(--wk-font)', transition: 'bottom .18s ease' }}>
      {expanded && (
        <div className="tc-sheet">
          <ClockChip vm={vm} onAfterAction={() => setExpanded(false)} />
        </div>
      )}
      <button type="button" className={`tc-pill${onBreak ? ' is-break' : ''}`} onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Time clock - tap for controls'}>
        <ClockRing pct={(vm.todayMin || 0) / (vm.targetMin || 480)} tone={onBreak ? 'break' : 'in'} size={20} stroke={3} ticks={Math.round((vm.targetMin || 480) / 60)} />
        <span className="tc-pill-time">{onBreak ? `On Break · ${vm.timer}` : vm.timer}</span>
        <ChevronUp size={13} style={{ color: 'var(--muted)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
    </div>
  </>);
}
