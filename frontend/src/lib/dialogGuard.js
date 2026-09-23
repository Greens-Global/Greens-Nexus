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

function emit() { subs.forEach(fn => fn(pending)); }

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

// Ask the person. Resolves true to discard (proceed), false to keep editing.
export function confirmDiscard() {
  if (pending) return pending.promise;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  pending = { promise, resolve: (v) => { pending = null; emit(); resolve(v); } };
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
  if (!hasDirtyDialog()) return;
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
