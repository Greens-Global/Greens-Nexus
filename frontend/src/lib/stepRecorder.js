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
let _lastPath = '';
let _pill = null;
let _onFlowSave = null;

// Pretty names for the url slugs the app navigates between (App.jsx keeps the
// address bar in sync with the active view, so the URL is the reliable "which
// screen am I on" signal — document.title never changes).
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
  // links, back/forward — everything), instead of relying on window events.
  const path = _pathNow();
  if (path !== _lastPath) {
    _lastPath = path;
    _events.push({ t: Date.now(), view: _screenName(path), role: 'opened', label: _screenName(path), path });
  }
}

function _onClick(e) {
  if (!_recording) return;
  if (_pill && _pill.contains(e.target)) return;   // ignore clicks on the pill itself
  // Walk up to the nearest meaningful control so we log "button 'Save'", not "svg".
  const el = e.target.closest?.('button, a, [role="button"], [role="tab"], select, input, textarea, label, th, [onclick]') || e.target;
  const tag = el.tagName?.toLowerCase() || 'element';
  // focusin exists only to catch typing/selecting — for buttons/links it just
  // echoes the click and doubled every entry.
  if (e.type === 'focusin' && !['input', 'textarea', 'select'].includes(tag)) return;
  const label = _labelOf(el);
  if (!label) return;
  const role = tag === 'input' || tag === 'textarea' ? 'typed into' : tag === 'select' ? 'picked from' : 'clicked';
  _trackScreen();
  const last = _events[_events.length - 1];
  // Collapse echoes: same action on the same control within 2s (double-fire of
  // click+focus, double-clicks, repeated keystroke focus) records once.
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

// ── bug-report mode (no pill; the Report-a-bug form owns the UI) ─────────────

export function startRecording() {
  _events = [];
  _recording = true;
  _attach();
  // Flows begin with where the user is, so replay can navigate there first.
  _events.push({ t: Date.now(), view: _screenName(_lastPath), role: 'opened', label: _screenName(_lastPath), path: _lastPath });
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
