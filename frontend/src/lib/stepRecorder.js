// ── Step recorder for the Testing module ─────────────────────────────────────
// Two uses:
//  1. Bug reports: log WHAT the user interacts with (screen + control label).
//  2. Replayable flows (Level 1): the same log, plus durable selector HINTS so
//     the flow can be replayed later (in-app replayer or an AI-generated
//     Playwright spec).
// Privacy: input VALUES are never captured — only "typed into '<label>'".
// The flow-mode pill is plain DOM (not React) so it survives navigating between
// modules while recording.

let _events = [];
let _recording = false;
let _view = document.title || '';
let _pill = null;
let _onFlowSave = null;

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

function _onClick(e) {
  if (!_recording) return;
  if (_pill && _pill.contains(e.target)) return;   // ignore clicks on the pill itself
  // Walk up to the nearest meaningful control so we log "button 'Save'", not "svg".
  const el = e.target.closest?.('button, a, [role="button"], [role="tab"], select, input, textarea, label, th, [onclick]') || e.target;
  const label = _labelOf(el);
  if (!label) return;
  const tag = el.tagName?.toLowerCase() || 'element';
  const role = tag === 'input' || tag === 'textarea' ? 'typed into' : tag === 'select' ? 'picked from' : 'clicked';
  const last = _events[_events.length - 1];
  // Collapse repeat keystroke focus events on the same field.
  if (last && last.role === role && last.label === label && role === 'typed into') return;
  _events.push({ t: Date.now(), view: _view, role, label, hints: _hintsOf(el) });
  if (_events.length > 400) _events.shift();
  _updatePill();
}

function _onNavigate(e) {
  const v = e?.detail?.view;
  if (v) {
    _view = v;
    if (_recording) { _events.push({ t: Date.now(), view: v, role: 'opened', label: v }); _updatePill(); }
  }
}

function _attach() {
  document.addEventListener('click', _onClick, true);
  document.addEventListener('focusin', _onClick, true);
  window.addEventListener('nexus:navigate', _onNavigate);
}

function _detach() {
  document.removeEventListener('click', _onClick, true);
  document.removeEventListener('focusin', _onClick, true);
  window.removeEventListener('nexus:navigate', _onNavigate);
}

// ── bug-report mode (no pill; the Report-a-bug form owns the UI) ─────────────

export function startRecording() {
  _events = [];
  _recording = true;
  _view = document.title || _view;
  _attach();
}

export function stopRecording() {
  _recording = false;
  _detach();
  _removePill();
  return _events.slice();
}

export function isRecording() { return _recording; }
export function eventCount() { return _events.length; }

// ── flow mode (Level 1): floating pill that survives view navigation ─────────

function _updatePill() {
  const n = _pill?.querySelector('[data-count]');
  if (n) n.textContent = `${_events.length} action${_events.length !== 1 ? 's' : ''}`;
}

function _removePill() {
  _pill?.remove();
  _pill = null;
  _onFlowSave = null;
}

export function startFlowRecording(onSave) {
  if (_recording) stopRecording();
  _onFlowSave = onSave;
  startRecording();
  _pill = document.createElement('div');
  _pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:3000;display:flex;align-items:center;gap:10px;'
    + 'background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;font:600 12.5px Inter,sans-serif;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.35)';
  _pill.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;animation:pulse 1.2s infinite"></span>'
    + '<span>Recording flow · <span data-count>0 actions</span></span>';
  const stop = document.createElement('button');
  stop.textContent = 'Stop & save';
  stop.style.cssText = 'border:none;border-radius:8px;background:#22c55e;color:#fff;font:700 12px Inter,sans-serif;padding:6px 12px;cursor:pointer';
  stop.onclick = () => { const events = stopRecording(); _onFlowSave?.(events); _removePill(); };
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel recording');
  cancel.style.cssText = 'border:none;background:none;color:#94a3b8;font:600 12px Inter,sans-serif;cursor:pointer;padding:6px 4px';
  cancel.onclick = () => { stopRecording(); _removePill(); };
  _pill.append(stop, cancel);
  document.body.appendChild(_pill);
}
