// Unsaved-changes guard: a small mutable singleton that the currently-mounted asset detail
// form registers itself into (dirty flag + save/cancel/startEdit callbacks), so navigation
// (Back button, tab switches, browser close) can prompt "you have unsaved changes" without
// prop-drilling the whole app. Reset to a no-op state whenever the editing form unmounts.
// `editing` and `subscribe` let the page header show Cancel / Save Changes while the
// form is in edit mode (Oct 21 2026).
const listeners = new Set();
export const editGuard = {
  dirty: false, editing: false, save: null, cancel: null, startEdit: null,
  /** Call after changing `editing` or `dirty` so subscribers re-render. */
  notify() { listeners.forEach((fn) => { try { fn(); } catch { /* a listener must not break the form */ } }); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (editGuard.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
