// ── Step recorder for the Testing module ─────────────────────────────────────
// While recording, logs WHAT the user interacts with (screen + control label)
// but NEVER what they type — input values are deliberately not captured, only
// "typed into '<placeholder/label>'". The log feeds the AI bug→test-case
// conversion so generated repro steps match what actually happened.

let _events = [];
let _recording = false;
let _view = document.title || '';

function _labelOf(el) {
  if (!el) return '';
  const aria = el.getAttribute?.('aria-label');
  if (aria) return aria.slice(0, 60);
  if (el.placeholder) return el.placeholder.slice(0, 60);
  if (el.title) return el.title.slice(0, 60);
  const txt = (el.innerText || el.value === undefined ? el.innerText : '')?.trim();
  if (txt) return txt.split('\n')[0].slice(0, 60);
  return el.name || el.id || el.tagName?.toLowerCase() || '';
}

function _onClick(e) {
  if (!_recording) return;
  // Walk up to the nearest meaningful control so we log "button 'Save'", not "svg".
  const el = e.target.closest?.('button, a, [role="button"], [role="tab"], select, input, textarea, label, th, [onclick]') || e.target;
  const label = _labelOf(el);
  if (!label) return;
  const tag = el.tagName?.toLowerCase() || 'element';
  const role = tag === 'input' || tag === 'textarea' ? 'typed into' : tag === 'select' ? 'picked from' : 'clicked';
  const last = _events[_events.length - 1];
  // Collapse repeat keystroke focus events on the same field.
  if (last && last.role === role && last.label === label && role === 'typed into') return;
  _events.push({ t: Date.now(), view: _view, role, label });
  if (_events.length > 400) _events.shift();
}

function _onNavigate(e) {
  const v = e?.detail?.view;
  if (v) { _view = v; if (_recording) _events.push({ t: Date.now(), view: v, role: 'opened', label: v }); }
}

export function startRecording() {
  _events = [];
  _recording = true;
  _view = document.title || _view;
  document.addEventListener('click', _onClick, true);
  document.addEventListener('focusin', _onClick, true);
  window.addEventListener('nexus:navigate', _onNavigate);
}

export function stopRecording() {
  _recording = false;
  document.removeEventListener('click', _onClick, true);
  document.removeEventListener('focusin', _onClick, true);
  window.removeEventListener('nexus:navigate', _onNavigate);
  return _events.slice();
}

export function isRecording() { return _recording; }
export function eventCount() { return _events.length; }
