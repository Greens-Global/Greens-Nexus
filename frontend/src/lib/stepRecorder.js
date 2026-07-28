// ── Step recorder for the Testing module ─────────────────────────────────────
// Records a bug the way a tester experiences it:
//  • STEPS  - what they interact with (screen + control label), never the values.
//  • VIDEO  - optional screen capture (getDisplayMedia) with the mic mixed in.
//  • VOICE  - optional narration, embedded in the video AND transcribed live
//             (Web Speech API) so it can auto-fill the bug description.
// One floating card owns all of it: Stop ends steps + video + voice together and
// drops the tester back on Report a bug with everything attached. The card is
// plain DOM (not React) so it survives navigating between modules while recording.
//
// It also powers replayable flows (Level 1): the same step log plus durable
// selector HINTS so a flow can be replayed (in-app replayer / Playwright spec).

let _events = [];
let _recording = false;
let _lastPath = '';
let _pill = null;

// video / voice capture (module-level so they survive cross-module navigation)
let _screenStream = null;
let _micStream = null;
let _mediaRec = null;
let _chunks = [];
let _bugVideoBlob = null;   // handed to Report-a-bug via takeBugVideoBlob()
let _recog = null;          // SpeechRecognition
let _speechOn = false;
let _transcript = '';
let _interim = '';          // latest not-yet-final phrase, committed on stop
let _finishing = false;

// Pretty names for the url slugs the app navigates between (App.jsx keeps the
// address bar in sync with the active view, so the URL is the reliable "which
// screen am I on" signal - document.title never changes).
const _SLUG_LABELS = {
  '': 'Dashboard', dashboard: 'Dashboard', 'manager-dashboard': 'Manager Dashboard',
  itemmanagement: 'Item Management', inventory: 'Item Management',
  hr: 'People', myhr: 'My HR', timeclock: 'Time Clock', tasks: 'Tasks',
  sop: 'Knowledge Base', documents: 'Documents', 'property-asset': 'Asset Management',
  accounting: 'Accounting', 'investor-relations': 'Investor Relations',
  marketing: 'Marketing', testing: 'Testing', purchase: 'Purchase', admin: 'Access Manager',
  it: 'IT', ops: 'Construction', operations: 'Operations', development: 'Development',
  'external-links': 'External Links', support: 'Support',
};

function _pathNow() { return window.location.pathname.split('/').filter(Boolean)[0] || 'dashboard'; }
function _screenName(slug) {
  return _SLUG_LABELS[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _hintsOf(el) {
  return {
    tag: el.tagName?.toLowerCase() || '',
    aria: el.getAttribute?.('aria-label') || '',
    text: (el.innerText || '').trim().split('\n')[0].slice(0, 60),
    placeholder: el.placeholder || '',
    title: el.title || '',
    name: el.name || '',
  };
}

function _labelOf(el) {
  if (!el) return '';
  const h = _hintsOf(el);
  return (h.aria || h.placeholder || h.title || h.text || h.name || el.id || h.tag || '').slice(0, 60);
}

function _trackScreen() {
  // Auto-log screen changes by watching the URL (covers sidebar clicks, deep
  // links, back/forward - everything), instead of relying on window events.
  const path = _pathNow();
  if (path === _lastPath) return;
  _lastPath = path;
  const name = _screenName(path);
  const last = _events[_events.length - 1];
  // The click that just navigated here already logged a "clicked …" row; the
  // navigation it caused would otherwise add a second "opened <Screen>" row -
  // one user action, two entries. Since a top-level screen change is always
  // triggered by that immediately-preceding click, fold the two into a single
  // "opened <Screen>" (keeps the path so replay can still navigate).
  if (last && last.role === 'clicked') {
    last.role = 'opened'; last.path = path; last.view = name; last.label = name;
    return;
  }
  _events.push({ t: Date.now(), view: name, role: 'opened', label: name, path });
}

function _onClick(e) {
  if (!_recording) return;
  if (_pill && _pill.contains(e.target)) return;   // ignore clicks on the pill itself
  // Walk up to the nearest meaningful control so we log "button 'Save'", not "svg".
  const el = e.target.closest?.('button, a, [role="button"], [role="tab"], select, input, textarea, label, th, [onclick]') || e.target;
  const tag = el.tagName?.toLowerCase() || 'element';
  // focusin exists only to catch typing/selecting - for buttons/links it just
  // echoes the click and doubled every entry.
  if (e.type === 'focusin' && !['input', 'textarea', 'select'].includes(tag)) return;
  const label = _labelOf(el);
  if (!label) return;
  const role = tag === 'input' || tag === 'textarea' ? 'typed into' : tag === 'select' ? 'picked from' : 'clicked';
  _trackScreen();
  const last = _events[_events.length - 1];
  // Collapse echoes: same action on the same control within 2s (click+focus
  // double-fire, double-clicks, repeated keystroke focus) records once.
  if (last && last.role === role && last.label === label && Date.now() - last.t < 2000) { last.t = Date.now(); return; }
  _events.push({ t: Date.now(), view: _screenName(_lastPath), role, label, hints: _hintsOf(el) });
  if (_events.length > 400) _events.shift();
  _updatePill();
}

function _attach() {
  _lastPath = _pathNow();
  document.addEventListener('click', _onClick, true);
  document.addEventListener('focusin', _onClick, true);
}

function _detach() {
  document.removeEventListener('click', _onClick, true);
  document.removeEventListener('focusin', _onClick, true);
}

// ── core step log ────────────────────────────────────────────────────────────

export function startRecording() {
  _events = [];
  _recording = true;
  _attach();
  // Flows begin with where the user is, so replay can navigate there first.
  _events.push({ t: Date.now(), view: _screenName(_lastPath), role: 'opened', label: _screenName(_lastPath), path: _lastPath });
}

export function stopRecording() {
  if (_recording) _trackScreen();   // fold a final navigation click into its "opened"
  _recording = false;
  _detach();
  _removePill();
  return _events.slice();
}

export function isRecording() { return _recording; }
export function eventCount() { return _events.length; }

// ── screen video + mic capture ───────────────────────────────────────────────

function _pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
}

// Resolves with the recorded Blob (or null) and tears every track down.
function _stopMedia() {
  return new Promise(resolve => {
    const rec = _mediaRec;
    const cleanup = () => {
      _micStream?.getTracks().forEach(t => t.stop()); _micStream = null;
      _screenStream?.getTracks().forEach(t => t.stop()); _screenStream = null;
    };
    if (!rec || rec.state === 'inactive') {
      const blob = _chunks.length ? new Blob(_chunks, { type: 'video/webm' }) : null;
      _chunks = []; _mediaRec = null; cleanup(); return resolve(blob);
    }
    rec.onstop = () => {
      const blob = _chunks.length ? new Blob(_chunks, { type: 'video/webm' }) : null;
      _chunks = []; _mediaRec = null; cleanup(); resolve(blob);
    };
    try { rec.stop(); } catch { _chunks = []; _mediaRec = null; cleanup(); resolve(null); }
  });
}

export function takeBugVideoBlob() { const b = _bugVideoBlob; _bugVideoBlob = null; return b; }
export function takeTranscript() { const t = _transcript; _transcript = ''; return t; }

// ── voice narration → live transcript (Web Speech API) ───────────────────────

function _commit(t) {
  t = (t || '').trim();
  if (t) _transcript += (_transcript ? ' ' : '') + t;
}

function _startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { console.warn('[qa-recorder] SpeechRecognition unsupported in this browser'); return false; }
  try {
    _recog = new SR();
    _recog.continuous = true;
    _recog.interimResults = true;   // capture partials so nothing is lost between pauses
    _recog.lang = 'en-US';
    _recog.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = (e.results[i][0].transcript || '').trim();
        if (e.results[i].isFinal) _commit(t);
        else interim = t;
      }
      _interim = interim;   // held until finalised or committed at stop
    };
    // Surface failures instead of dying silently. 'no-speech'/'aborted'/'network'
    // are transient - let onend restart. 'not-allowed'/'service-not-allowed' mean
    // the mic/speech service is blocked: stop trying.
    _recog.onerror = ev => {
      console.warn('[qa-recorder] speech error:', ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') _speechOn = false;
    };
    // Recognition auto-stops after a pause; restart it until we explicitly stop.
    _recog.onend = () => {
      if (_interim) { _commit(_interim); _interim = ''; }   // don't drop a trailing phrase
      if (_speechOn) { try { _recog.start(); } catch { /* already starting */ } }
    };
    _recog.start();
    _speechOn = true;
    return true;
  } catch (err) { console.warn('[qa-recorder] speech start failed:', err); _recog = null; return false; }
}

function _stopSpeech() {
  _speechOn = false;
  if (_interim) { _commit(_interim); _interim = ''; }
  try { _recog?.stop(); } catch { /* ignore */ }
  _recog = null;
}

// ── flow mode (Level 1) + bug mode: floating card that survives navigation ────

function _updatePill() {
  const n = _pill?.querySelector('[data-count]');
  if (n) n.textContent = `${_events.length} action${_events.length !== 1 ? 's' : ''}`;
}

function _removePill() {
  _pill?.remove();
  _pill = null;
}

function _showPill({ text, stopLabel, onStopClick, onCancelClick }) {
  _pill = document.createElement('div');
  _pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:3000;display:flex;align-items:center;gap:10px;'
    + 'background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;font:600 12.5px Inter,sans-serif;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.35)';
  _pill.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;animation:pulse 1.2s infinite"></span>'
    + `<span>${text} · <span data-count>0 actions</span></span>`;
  const stop = document.createElement('button');
  stop.textContent = stopLabel;
  stop.style.cssText = 'border:none;border-radius:8px;background:#22c55e;color:#fff;font:700 12px Inter,sans-serif;padding:6px 12px;cursor:pointer';
  stop.onclick = onStopClick;
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel recording');
  cancel.style.cssText = 'border:none;background:none;color:#94a3b8;font:600 12px Inter,sans-serif;cursor:pointer;padding:6px 4px';
  cancel.onclick = onCancelClick;
  _pill.append(stop, cancel);
  document.body.appendChild(_pill);
}

export function startFlowRecording(onSave) {
  if (_recording) stopRecording();
  startRecording();
  _showPill({
    text: 'Recording flow', stopLabel: 'Stop & save',
    onStopClick: () => { const events = stopRecording(); onSave?.(events); },
    onCancelClick: () => { stopRecording(); },
  });
}

// Bug-steps recording with a floating card. `opts.video` also captures the
// screen; `opts.voice` mixes the mic into that video and transcribes it live.
// Stop (card button OR Chrome's own "Stop sharing") ends everything at once and
// lands the tester back on Report a bug with steps + video + narration attached.
export async function startBugRecording(opts = {}) {
  const { video = false, voice = false } = opts;
  if (_recording) stopRecording();
  _bugVideoBlob = null; _transcript = ''; _interim = ''; _chunks = []; _finishing = false;

  let haveVideo = false, haveVoice = false;
  if (video) {
    try {
      _screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
      haveVideo = true;
      if (voice) {
        try {
          _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          _micStream.getAudioTracks().forEach(t => _screenStream.addTrack(t));
        } catch { /* mic denied - video only, transcript may still run below */ }
      }
      _mediaRec = new MediaRecorder(_screenStream, { mimeType: _pickMime() });
      _mediaRec.ondataavailable = e => e.data.size && _chunks.push(e.data);
      _mediaRec.start(1000);
      // Chrome's browser-chrome "Stop sharing" ends the video track - treat it
      // as a Stop so nothing is lost even if they use the browser control.
      _screenStream.getVideoTracks()[0].addEventListener('ended', () => _finishBug());
    } catch { haveVideo = false; /* cancelled the screen picker → steps only */ }
  }
  if (voice) haveVoice = _startSpeech();

  startRecording();
  const parts = [];
  if (haveVideo) parts.push('video');
  if (haveVoice) parts.push('voice');
  parts.push('steps');
  _showPill({
    text: `Recording bug - ${parts.join(' + ')}`,
    stopLabel: 'Stop',
    onStopClick: () => _finishBug(),
    onCancelClick: () => _cancelBug(),
  });
  return { haveVideo, haveVoice };
}

async function _finishBug() {
  if (_finishing) return; _finishing = true;
  const events = stopRecording();   // stops the step log + removes the card
  _stopSpeech();
  const blob = await _stopMedia();
  _bugVideoBlob = blob;
  try {
    sessionStorage.setItem('qa-bug-steps', JSON.stringify(events));
    if (_transcript) sessionStorage.setItem('qa-bug-transcript', _transcript);
  } catch { /* storage full - steps still return via the blob/transcript getters */ }
  _finishing = false;
  window.history.pushState(null, '', '/testing');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function _cancelBug() {
  stopRecording();
  _stopSpeech();
  _stopMedia();
  _bugVideoBlob = null; _transcript = '';
}
