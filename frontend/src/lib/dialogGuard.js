// App-wide guard against losing work in a popup (Neil, Sep 22): a click on
// the backdrop, Escape, an in-app navigation, or closing the tab must never
// silently throw away what someone has typed into a dialog. Nexus has
// dozens of hand-rolled popups across its modules; rather than wiring each
// one, this watches the whole document once:
//
//   - Dirty tracking: any `input` / `change` inside a dialog marks that
//     dialog's backdrop as dirty (data-nx-dirty). Search boxes and anything
//     under [data-nx-noguard] are ignored - filtering a list is not work.
//   - Backdrop clicks and Escape are intercepted in the capture phase,
//     before any dialog's own handler, when the topmost dialog is dirty.
//     The shared prompt (components/DialogGuard.jsx) asks; on Discard the
//     original event is replayed with `bypass` set so the dialog's own
//     close logic runs exactly as it would have.
//   - Shells that already carry their own unsaved-changes prompt
//     (useUnsavedGuard and the module Modal wrappers) check isBypassing()
//     so a Discard here does not ask a second time there.
//   - App.jsx's navigate() and a beforeunload handler consult
//     hasDirtyDialog() so leaving the page asks too.
//
// A "backdrop" is any element with the .modal-overlay / .nx-tasks-portal
// class or [data-nx-backdrop], or any fixed-position element the size of
// the viewport - which is how every inline-styled overlay in the app is
// built, so no popup has to opt in.

const BACKDROP_SEL = '.modal-overlay, .nx-tasks-portal, [data-nx-backdrop]';
const NOGUARD_SEL = '[data-nx-noguard], input[type="search"], [role="searchbox"], input[type="checkbox"][data-nx-filter]';

let bypass = false;
let pending = null; // { resolve(boolean) }
const subs = new Set();
const known = new Set(); // backdrops seen dirty, for topmost() lookups

// A fresh object each time, so a subscriber re-renders when what is unsaved changes.
function emit() { const p = pending && { ...pending }; subs.forEach(fn => fn(p)); }

export function subscribe(fn) { subs.add(fn); fn(pending); return () => subs.delete(fn); }
export function isBypassing() { return bypass; }

function isViewportFixed(el) {
  const cs = getComputedStyle(el);
  if (cs.position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2;
}
function isBackdrop(el) {
  return el instanceof Element && (el.matches(BACKDROP_SEL) || isViewportFixed(el));
}
function backdropOf(el) {
  let n = el instanceof Element ? el : null;
  while (n && n !== document.body) {
    if (isBackdrop(n)) return n;
    n = n.parentElement;
  }
  return null;
}
function isSearchLike(el) {
  if (!(el instanceof Element)) return false;
  if (el.closest(NOGUARD_SEL)) return true;
  const ph = (el.getAttribute('placeholder') || '').trim().toLowerCase();
  return ph.startsWith('search') || ph.startsWith('filter') || ph.startsWith('find');
}

// The topmost backdrop on screen: last in document order among the known
// ones still attached (portals append to body, so document order is stack
// order for every shell in the app).
function topmost() {
  const all = [...document.querySelectorAll(BACKDROP_SEL), ...known].filter(el => el.isConnected);
  if (!all.length) return null;
  all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // The prompt itself sits on top while it is open; look under it.
  return all.reverse().find(el => !el.hasAttribute('data-nx-prompt')) || null;
}
export function hasDirtyDialog() {
  const top = topmost();
  return !!(top && top.hasAttribute('data-nx-dirty'));
}

// Inline forms with unsaved work - the Settings groups (lib/groupDirty.js):
// no backdrop to watch, so the shell says so itself. Leaving the page or
// the module asks for them too; a backdrop click or Escape is not theirs.
// `meta` says what is unsaved, for the prompt: `labels` (the group titles)
// and `save` (resolves true once it all saved - lib/groupDirty.js), so the
// prompt can name the forms and offer Save and Leave.
const inlineDirty = new Map();
export function setInlineDirty(key, dirty, meta = null) {
  if (dirty) inlineDirty.set(key, meta || {}); else inlineDirty.delete(key);
  if (pending) emit();
}
export function hasUnsavedWork() { return hasDirtyDialog() || inlineDirty.size > 0 || !!leaveAsk; }

// What the plain prompt can say about the unsaved work: the names of the
// inline forms, and one save for them all - only when nothing else (a dirty
// popup, a screen's own guard) is unsaved and every form can save itself.
export function unsavedSummary() {
  const entries = [...inlineDirty.values()];
  const labels = [...new Set(entries.flatMap(m => m.labels || []))];
  const saves = entries.map(m => m.save);
  const save = entries.length && !hasDirtyDialog() && !leaveAsk && saves.every(s => typeof s === 'function')
    ? async () => {
      try { return (await Promise.all(saves.map(s => s()))).every(r => r === true); } catch { return false; }
    }
    : null;
  return { labels, save };
}

// The browser's Back / Forward with unsaved work (App.jsx's popstate): the
// address has already moved, so put the entry we were on back, ask, and on
// Discard (or a save that landed) step back again to where the person was
// going - that second popstate goes through. `rememberEntry` notes the entry
// on screen after every move.
let lastEntry = null;
let leavingPop = false;
export function rememberEntry() {
  if (typeof window === 'undefined') return;
  lastEntry = { state: window.history.state, url: window.location.href };
}
export function guardPopstate(e, apply) {
  if (!leavingPop && lastEntry && hasUnsavedWork()) {
    const back = lastEntry;
    window.history.pushState(back.state, '', back.url);
    askToLeave().then(ok => {
      if (!ok) return;
      leavingPop = true;
      window.history.back();
    });
    return false;
  }
  leavingPop = false;
  apply(e);
  rememberEntry();
  return true;
}

// A screen with its own Save / Keep Editing / Discard prompt (the shift
// schedule's unshared drafts, Neil Oct 28 2026) registers how to ask; leaving
// asks it instead of the plain prompt. `fn` resolves true to leave.
let leaveAsk = null;
export function setLeaveGuard(fn) { leaveAsk = fn || null; }
export function askToLeave() {
  return hasDirtyDialog() || inlineDirty.size > 0 || !leaveAsk ? confirmDiscard() : leaveAsk();
}

// Ask the person. Resolves true to discard (proceed), false to keep editing.
export function confirmDiscard() {
  if (pending) return pending.promise;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  pending = { promise, summary: unsavedSummary, resolve: (v) => { pending = null; emit(); resolve(v); } };
  emit();
  return promise;
}

function markDirty(e) {
  if (isSearchLike(e.target)) return;
  const bd = backdropOf(e.target);
  if (!bd || bd.hasAttribute('data-nx-prompt')) return;
  bd.setAttribute('data-nx-dirty', '1');
  known.add(bd);
}

function onClickCapture(e) {
  if (bypass || e.button !== 0) return;
  const bd = e.target;
  if (!isBackdrop(bd) || !bd.hasAttribute('data-nx-dirty') || bd.hasAttribute('data-nx-prompt')) return;
  if (bd !== topmost()) return;
  e.stopPropagation();
  e.preventDefault();
  confirmDiscard().then(ok => {
    if (!ok || !bd.isConnected) return;
    bypass = true;
    try { bd.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
    finally { bypass = false; }
  });
}

function onKeyCapture(e) {
  if (bypass || e.key !== 'Escape') return;
  const top = topmost();
  if (!top || !top.hasAttribute('data-nx-dirty')) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  confirmDiscard().then(ok => {
    if (!ok || !top.isConnected) return;
    bypass = true;
    try {
      // Replayed from inside the dialog so React's own handlers see it
      // (they listen on the portal / root container), then it bubbles on to
      // the document and window listeners the shells use.
      const from = top.querySelector('input, textarea, select, button, [tabindex]') || top;
      from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } finally { bypass = false; }
  });
}

function onBeforeUnload(e) {
  if (!hasUnsavedWork()) return;
  e.preventDefault();
  e.returnValue = '';
}

let installed = false;
export function installDialogGuard() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('input', markDirty, true);
  document.addEventListener('change', markDirty, true);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('keydown', onKeyCapture, true);
  window.addEventListener('beforeunload', onBeforeUnload);
}
