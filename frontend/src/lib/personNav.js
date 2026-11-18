// Cross-view jump to a specific person's profile in the People module.
//
// App.jsx's `nexus:navigate` handler only reads {view, sub} - anything else on
// the detail is dropped - and the People view may not be mounted yet when the
// event fires, so a listener there would miss the very first jump. Hence the
// handoff below: stash the email, navigate, and let People claim it on mount.
let _pending = '';
let _pendingTab = '';

// `tab` (optional) opens the person on one of their tabs, e.g. 'checklist'
// (the Exits sheet's Open Checklist, 11/14/2026).
export function openPersonProfile(email, tab = '') {
  const em = (email || '').trim().toLowerCase();
  if (!em) return;
  _pending = em;
  _pendingTab = tab || '';
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'hr', sub: 'hr-people' } }));
  // For a People view that IS already mounted - it never re-mounts, so the
  // stash alone would sit unread until the next mount.
  window.dispatchEvent(new CustomEvent('nexus:person', { detail: { email: em, tab: tab || '' } }));
}

// Read-and-clear: the jump is consumed once, so returning to People later does
// not silently re-open a person the user has since navigated away from.
export function takePendingPerson() {
  const em = _pending;
  _pending = '';
  return em;
}

// The tab that came with the stashed jump ('' = the profile's default).
export function takePendingTab() {
  const t = _pendingTab;
  _pendingTab = '';
  return t;
}
