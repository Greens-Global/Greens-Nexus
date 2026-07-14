// ── In-app flow replayer (Testing module, Level 1) ────────────────────────────
// Walks a recorded flow: navigates between modules, finds each recorded control
// by its durable hints, highlights it and clicks it for real. It is deliberately
// SEMI-automated: typed fields and dropdowns pause for the human (we never record
// values), and any control it can't find pauses with "do it manually, then
// Resume" instead of failing. Plain DOM pill so it survives view navigation.

let _state = null;   // { flow, i, paused, pill, onDone }

function _visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function _findEl(action) {
  const h = action.hints || {};
  const norm = s => (s || '').trim().toLowerCase();
  const want = norm(action.label);
  const candidates = [];
  if (h.aria) candidates.push(...document.querySelectorAll(`[aria-label="${CSS.escape(h.aria)}"]`));
  if (h.placeholder) candidates.push(...document.querySelectorAll(`[placeholder="${CSS.escape(h.placeholder)}"]`));
  if (h.title) candidates.push(...document.querySelectorAll(`[title="${CSS.escape(h.title)}"]`));
  if (h.name) candidates.push(...document.querySelectorAll(`[name="${CSS.escape(h.name)}"]`));
  const found = candidates.find(_visible);
  if (found) return found;
  // Fall back to visible text on interactive elements (exact, then startsWith).
  const pool = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], th, label')].filter(_visible);
  return pool.find(el => norm(el.innerText).split('\n')[0] === want)
      || pool.find(el => norm(el.innerText).startsWith(want.slice(0, 30)))
      || null;
}

function _highlight(el) {
  const prev = el.style.outline;
  el.style.outline = '3px solid #3b82f6';
  el.style.outlineOffset = '2px';
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = ''; }, 900);
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

function _pill() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:3000;display:flex;flex-direction:column;gap:8px;'
    + 'background:#0f172a;color:#fff;border-radius:12px;padding:12px 16px;font:600 12.5px Inter,sans-serif;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:340px';
  el.innerHTML = '<div style="display:flex;align-items:center;gap:8px">'
    + '<span style="width:8px;height:8px;border-radius:50%;background:#3b82f6"></span>'
    + '<span data-status style="flex:1">Replaying…</span></div>'
    + '<div data-msg style="font-weight:400;color:#cbd5e1;display:none"></div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end">'
    + '<button data-resume style="display:none;border:none;border-radius:8px;background:#22c55e;color:#fff;font:700 12px Inter,sans-serif;padding:6px 12px;cursor:pointer">Resume</button>'
    + '<button data-stop style="border:none;background:none;color:#94a3b8;font:600 12px Inter,sans-serif;cursor:pointer;padding:6px 4px">Stop</button></div>';
  document.body.appendChild(el);
  return el;
}

function _setStatus(text, msg = '') {
  if (!_state) return;
  _state.pill.querySelector('[data-status]').textContent = text;
  const m = _state.pill.querySelector('[data-msg]');
  m.textContent = msg;
  m.style.display = msg ? 'block' : 'none';
  _state.pill.querySelector('[data-resume]').style.display = _state.paused ? 'inline-block' : 'none';
}

function _pause(msg) {
  _state.paused = true;
  _setStatus(`Paused at ${_state.i + 1}/${_state.flow.length}`, msg);
}

async function _run() {
  const s = _state;
  while (s && s === _state && s.i < s.flow.length) {
    if (s.paused) { await _sleep(300); continue; }
    const a = s.flow[s.i];
    _setStatus(`Step ${s.i + 1}/${s.flow.length}: ${a.role} “${a.label}”`);
    if (a.role === 'opened') {
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: a.label } }));
      await _sleep(900);
      s.i += 1;
      continue;
    }
    // Auto-wait: poll for the control for up to 5 s (screens load async).
    let el = null;
    for (let tries = 0; tries < 10 && !el; tries++) { el = _findEl(a); if (!el) await _sleep(500); }
    if (!el) { _pause(`Couldn't find “${a.label}” — do that step manually, then Resume.`); s.i += 1; continue; }
    _highlight(el);
    await _sleep(650);
    if (a.role === 'typed into') { el.focus(); _pause(`Type into “${a.label}” yourself (values aren't recorded), then Resume.`); s.i += 1; continue; }
    if (a.role === 'picked from') { el.focus(); _pause(`Pick the option in “${a.label}” yourself, then Resume.`); s.i += 1; continue; }
    el.click();
    await _sleep(600);
    s.i += 1;
  }
  if (s && s === _state) {
    _setStatus('Replay finished — mark the verdict on the case.');
    await _sleep(3500);
    stopReplay(true);
  }
}

export function replayFlow(flow, { onDone } = {}) {
  stopReplay();
  _state = { flow: flow || [], i: 0, paused: false, pill: _pill(), onDone };
  _state.pill.querySelector('[data-resume]').onclick = () => { _state.paused = false; _setStatus('Replaying…'); };
  _state.pill.querySelector('[data-stop]').onclick = () => stopReplay(true);
  _run();
}

export function stopReplay(fireDone = false) {
  if (!_state) return;
  const { pill, onDone } = _state;
  _state = null;
  pill.remove();
  if (fireDone) onDone?.();
}

export function isReplaying() { return !!_state; }
