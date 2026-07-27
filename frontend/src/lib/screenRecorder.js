// ── Generic screen recorder ───────────────────────────────────────────────────
// A plain screen (+ optional mic) capture used outside the Testing module's
// QA-specific step-log/live-transcription flow (see stepRecorder.js — that one
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

function _showPill(onStop, onCancel) {
  _pill = document.createElement('div');
  _pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:3000;display:flex;align-items:center;gap:10px;'
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
 * once — Stop, the browser's own "Stop sharing" chip, or Cancel all funnel
 * into it (null on cancel/failure). Returns false without calling onDone if
 * the user dismissed the screen-share picker.
 */
export async function startScreenRecording({ voice = false } = {}, onDone) {
  if (_recording) { try { _mediaRec?.stop(); } catch { /* already stopped */ } _cleanupTracks(); _removePill(); _recording = false; }
  _chunks = [];
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
  } catch {
    return false;   // picker dismissed / permission denied
  }
  _screenStream = stream;
  if (voice) {
    try {
      _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _micStream.getAudioTracks().forEach((t) => _screenStream.addTrack(t));
    } catch { /* mic denied — video only */ }
  }
  _mediaRec = new MediaRecorder(_screenStream, { mimeType: _pickMime() });
  _mediaRec.ondataavailable = (e) => e.data.size && _chunks.push(e.data);
  _recording = true;

  const finish = () => {
    if (!_recording) return;
    _recording = false;
    const rec = _mediaRec;
    const done = (blob) => { _removePill(); _cleanupTracks(); onDone?.(blob); };
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
  // Chrome's own "Stop sharing" chip ends the video track — treat as Stop so
  // nothing is lost even if the tester uses the browser control instead of ours.
  _screenStream.getVideoTracks()[0].addEventListener('ended', finish);
  _mediaRec.start(1000);
  _showPill(finish, cancel);
  return true;
}
