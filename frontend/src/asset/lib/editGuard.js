// Unsaved-changes guard: a small mutable singleton that the currently-mounted asset detail
// form registers itself into (dirty flag + save/cancel/startEdit callbacks), so navigation
// (Back button, tab switches, browser close) can prompt "you have unsaved changes" without
// prop-drilling the whole app. Reset to a no-op state whenever the editing form unmounts.
export const editGuard = { dirty: false, save: null, cancel: null, startEdit: null };

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (editGuard.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
