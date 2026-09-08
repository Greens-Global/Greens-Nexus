// ── Generic screen recorder ───────────────────────────────────────────────────
// A plain screen (+ optional mic) capture used outside the Testing module's
// QA-specific step-log/live-transcription flow (see stepRecorder.js - that one
// also hard-navigates back to /testing on stop, which makes it unsafe to reuse
// from other modules). This one just returns a video Blob via callback and
// never touches routing, so any module can drop it in.

let _screenStream = null;
let _micStream = null;
let _mediaRec = null;
let _chunks = [];
let _pill = null;
let _recording = false;

function _pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
}

function _cleanupTracks() {
  _micStream?.getTracks().forEach((t) => t.stop()); _micStream = null;
  _screenStream?.getTracks().forEach((t) => t.stop()); _screenStream = null;
  _mediaRec = null; _chunks = [];
}

function _removePill() { _pill?.remove(); _pill = null; }

// ── "Recording captured" toast ────────────────────────────────────────────
// Fires once a finished recording has a real blob, offering a local copy on
// the spot rather than making someone dig it out of the ticket's attachment
// list afterward. Plain DOM, like _showPill - it must survive whatever
// unmount/navigation is already in flight when the caller's onDone runs.
// Sits in the SAME corner the in-progress pill uses (bottom-right): the pill
// is always removed before this appears, so the two never overlap, and that
// corner is clear of the app's own notification toasts (top-right, see
// NotificationToasts.jsx). "Captured", not "saved" - upload to the ticket
// happens async in the caller, after onDone fires, so this can't promise
// that part is done yet.
const _TOAST_MS = 15000;

function _showRecordingToast(blob) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:6000;display:flex;align-items:center;gap:10px;'
    + 'background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;font:600 12.5px Inter,sans-serif;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.35)';
  toast.innerHTML = '<span>Recording captured - saving to the ticket…</span>';

  let url = null;
  const cleanup = () => { if (url) { URL.revokeObjectURL(url); url = null; } toast.remove(); clearTimeout(timer); };

  const download = document.createElement('button');
  download.textContent = 'Download';
  download.style.cssText = 'border:none;border-radius:8px;background:#2563eb;color:#fff;font:700 12px Inter,sans-serif;padding:6px 12px;cursor:pointer;flex-shrink:0';
  download.onclick = () => {
    if (!url) url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ticket-recording-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const dismiss = document.createElement('button');
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.style.cssText = 'border:none;background:none;color:#94a3b8;font:700 13px Inter,sans-serif;cursor:pointer;padding:2px 4px;flex-shrink:0';
  dismiss.onclick = cleanup;

  toast.append(download, dismiss);
  document.body.appendChild(toast);
  const timer = setTimeout(cleanup, _TOAST_MS);
}

// ── Bringing the tab back after recording ───────────────────────────────────
// A web page cannot minimize or otherwise control a DIFFERENT application's
// window - there is no browser API for that, by design (sandboxing means a
// site can only ever act on itself). What we CAN do when recording ends
// while this tab is in the background (a different app, or a different
// browser tab) is: try to refocus ourselves (works when the browser allows
// it - not guaranteed, since focus-stealing is deliberately restricted),
// flash the tab title so it stands out in the taskbar/tab strip either way,
// and - the one mechanism that reliably reaches across a totally different
// application - show a system notification whose click handler focuses this
// tab. All three are no-ops if the tab was already visible when recording
// stopped.
let _titleFlashTimer = null;
let _titleFlashOrig = null;

function _stopTitleFlash() {
  if (_titleFlashTimer) { clearInterval(_titleFlashTimer); _titleFlashTimer = null; }
  if (_titleFlashOrig !== null) { document.title = _titleFlashOrig; _titleFlashOrig = null; }
  document.removeEventListener('visibilitychange', _stopTitleFlash);
  window.removeEventListener('focus', _stopTitleFlash);
}

function _flashTitle() {
  if (_titleFlashTimer) return;   // already flashing from an earlier recording
  _titleFlashOrig = document.title;
  let on = false;
  _titleFlashTimer = setInterval(() => {
    document.title = on ? _titleFlashOrig : '● Recording ready';
    on = !on;
  }, 1000);
  // Stops itself the moment the person actually comes back - nothing to clean
  // up on their end, and the title never gets stuck mid-flash.
  document.addEventListener('visibilitychange', _stopTitleFlash);
  window.addEventListener('focus', _stopTitleFlash);
}

// Notification permission only prompts from a genuine, recent user gesture,
// and the moment we USED to ask - inside startScreenRecording, right before
// the getDisplayMedia screen/window/tab picker - meant the permission popup
// and the picker showed back-to-back. Two browser prompts landing on top of
// each other reads as one confusing interruption, and the permission one
// (easy to mistake for spam, unlike the picker which is obviously required)
// was very likely the one getting reflexively dismissed - which would explain
// "it never brings me back": no permission, no notification, ever.
// primeReturnCue() exists so a caller can ask MUCH earlier - the moment
// someone clicks the "Record" button itself, before they've even chosen
// Screen/Screen+narration - so it's a single, separate, unhurried prompt with
// nothing else competing for the click. startScreenRecording still calls the
// same guarded ask as a fallback for any caller that skips priming.
let _notifyAsked = false;
// A short two-tone chime, synthesized rather than shipped as an asset -
// doesn't need any permission at all (unlike Notification), so it is the one
// "come back" cue that reliably crosses into a different application even
// when the person never granted (or was never asked for) notifications.
// AudioContexts created/resumed OUTSIDE a direct user-gesture call stack can
// get stuck 'suspended' by the browser's autoplay policy - created here, in
// primeReturnCue (called straight from the Record button's onClick), it
// resumes inside a real gesture and stays usable for the rest of the page's
// life, so _chime() later (from an async track/recorder callback, no gesture
// of its own) has a context that's already running rather than gambling on
// a fresh resume() succeeding at that point.
let _audioCtx = null;
function _ensureAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_audioCtx) _audioCtx = new Ctx();
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

export function primeReturnCue() {
  try { _ensureAudioCtx(); } catch { /* ignore */ }
  if (_notifyAsked || typeof Notification === 'undefined') return;
  _notifyAsked = true;
  if (Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch { /* ignore */ }
  }
}

function _chime() {
  try {
    const ctx = _ensureAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [[880, now, 0.14], [1175, now + 0.13, 0.18]].forEach(([freq, at, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    });
  } catch { /* Web Audio unavailable/blocked - the visual cues still cover it */ }
}

function _bringTabBack() {
  if (!document.hidden && document.hasFocus()) return;   // already in view
  try { window.focus(); } catch { /* browsers can refuse to steal focus */ }
  _flashTitle();
  _chime();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('Recording finished', { body: 'Switch back to Nexus to continue.', tag: 'nexus-recording-done' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers restrict Notification from a background tab - the title flash and chime still cover it */ }
  }
}

function _showPill(onStop, onCancel) {
  _pill = document.createElement('div');
  // z-index above every app overlay (task/ticket modals portal at 4000) - the
  // Stop button sat UNDER the create-ticket modal and could never be clicked.
  _pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:6000;display:flex;align-items:center;gap:10px;'
    + 'background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;font:600 12.5px Inter,sans-serif;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.35)';
  _pill.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;animation:pulse 1.2s infinite"></span>'
    + '<span>Recording screen…</span>';
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.style.cssText = 'border:none;border-radius:8px;background:#22c55e;color:#fff;font:700 12px Inter,sans-serif;padding:6px 12px;cursor:pointer';
  stop.onclick = onStop;
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel recording');
  cancel.style.cssText = 'border:none;background:none;color:#94a3b8;font:600 12px Inter,sans-serif;cursor:pointer;padding:6px 4px';
  cancel.onclick = onCancel;
  _pill.append(stop, cancel);
  document.body.appendChild(_pill);
}

export function isScreenRecording() { return _recording; }

/**
 * Starts a screen recording (+ mic if voice=true). `onDone(blob|null)` fires
 * once - Stop, the browser's own "Stop sharing" chip, or Cancel all funnel
 * into it (null on cancel/failure).
 *
 * Throws if the browser doesn't support screen capture at all, or if
 * getDisplayMedia rejects for a reason other than the user dismissing the
 * picker / denying permission (both surface as NotAllowedError - the caller
 * is expected to stay quiet on that one, same as the picker-cancel handling
 * in stepRecorder.js's startBugRecording).
 */
export async function startScreenRecording({ voice = false } = {}, onDone) {
  if (_recording) { try { _mediaRec?.stop(); } catch { /* already stopped */ } _cleanupTracks(); _removePill(); _recording = false; }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen recording isn\'t supported in this browser.');
  }
  primeReturnCue();   // no-op if the caller already primed on the Record click
  _chunks = [];
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
  _screenStream = stream;
  if (voice) {
    try {
      _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream.getAudioTracks().forEach((t) => _screenStream.addTrack(t));
    } catch { /* mic denied - video only */ }
  }
  _mediaRec = new MediaRecorder(_screenStream, { mimeType: _pickMime() });
  _mediaRec.ondataavailable = (e) => e.data.size && _chunks.push(e.data);
  _recording = true;

  const finish = () => {
    if (!_recording) return;
    _recording = false;
    const rec = _mediaRec;
    const done = (blob) => { _removePill(); _cleanupTracks(); _bringTabBack(); if (blob) _showRecordingToast(blob); onDone?.(blob); };
    if (!rec || rec.state === 'inactive') { done(_chunks.length ? new Blob(_chunks, { type: 'video/webm' }) : null); return; }
    rec.onstop = () => done(_chunks.length ? new Blob(_chunks, { type: 'video/webm' }) : null);
    try { rec.stop(); } catch { done(null); }
  };
  const cancel = () => {
    _recording = false;
    try { _mediaRec?.stop(); } catch { /* ignore */ }
    _removePill(); _cleanupTracks();
    onDone?.(null);
  };
  // Chrome's own "Stop sharing" chip ends the video track - treat as Stop so
  // nothing is lost even if the tester uses the browser control instead of ours.
  _screenStream.getVideoTracks()[0].addEventListener('ended', finish);
  _mediaRec.start(1000);
  _showPill(finish, cancel);
  return true;
}
