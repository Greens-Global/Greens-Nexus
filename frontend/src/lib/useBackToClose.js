// The phone's Back button / swipe-back closes the sheet on top, not the screen.
//
// On a phone a Modal or BottomSheet fills the screen and looks like a page,
// so Back is what people press to leave it - and Back used to go to the
// previous SCREEN, throwing the sheet (and whatever was typed in it) away.
//
// How: an open sheet pushes one history entry of its own - same URL, and a
// copy of App.jsx's entry state ({ depth, fromLabel }) plus an `nxSheet`
// marker. Back pops that entry; this module's popstate listener, registered
// on window in the CAPTURE phase so it runs before App.jsx's listener, sees
// the pop, stops it there (App never hears of it, so the view does not
// change and its depth counting is untouched), and asks the topmost sheet to
// close. Nested sheets (a ticket drawer with a dialog over it) unwind one
// per Back. A sheet closed any other way (its X, Done, Escape) takes its own
// entry back off with history.back(), and that pop is swallowed the same way.
//
// A sheet that declines to close (unsaved-changes prompt, a drill-in sheet
// stepping back a level) simply stays mounted; its entry is pushed again so
// the next Back still lands on it.
//
// If a sheet is unmounted by an in-app navigation, App.jsx pushes the new
// screen's entry over the sheet's, which then can't be removed. Landing on
// such a stale entry later skips straight over it. App.jsx is not edited.
import { useEffect, useId, useRef } from 'react';

const live = [];          // open sheets, bottom to top: { id, uid, path, handler }
let pending = 0;          // history traversals this module started that have not landed
let pendingPath = null;   // the URL they started from
let installed = false;
let seq = 0;

const markerOf = (state) => (state && typeof state === 'object' ? state.nxSheet || null : null);
const isLive = (id) => live.some((s) => s.id === id);

function push(sheet, idx, replace = false) {
  const base = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  const state = { ...base, nxSheet: { id: sheet.id, uid: sheet.uid, idx, path: sheet.path } };
  if (replace) window.history.replaceState(state, '');
  else window.history.pushState(state, '');
}

let pendingTimer = null;

function traverse(n) {
  pending += 1;
  pendingPath = window.location.pathname;
  // A traversal that never reports back (the browser dropped it) must not
  // leave every later Back mistaken for one of ours.
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { if (pending > 0) { pending = 0; reconcile(); } }, 600);
  window.history.go(-n);
}

// After Back has asked sheets to close: any that are still open (they
// declined) get their entries back, in stacking order.
function reconcile() {
  const m = markerOf(window.history.state);
  const have = m && isLive(m.id) ? live.findIndex((s) => s.id === m.id) + 1 : 0;
  for (let i = have; i < live.length; i += 1) push(live[i], i + 1);
}

function onPop(e) {
  const m = markerOf(e.state);
  const path = window.location.pathname;

  if (pending > 0) {
    // Our own history.back()/go(): it only ever lands on the same screen.
    pending -= 1;
    if (path === pendingPath) e.stopImmediatePropagation();
    if (m && !isLive(m.id)) { traverse(1); return; }   // landed on a stale entry - keep going
    if (pending === 0) { clearTimeout(pendingTimer); reconcile(); }   // entries for sheets opened meanwhile
    return;
  }

  if (m && !isLive(m.id)) {
    // A stale sheet entry (see the header). Coming from another screen App
    // must still switch views, so it is let through; then step over it.
    traverse(1);
    return;
  }

  const top = live[live.length - 1];
  if (!m && !top) return;                                // not ours
  if (path !== (m ? m.path : top.path)) return;          // a jump across screens: App's
  e.stopImmediatePropagation();
  const keep = m ? live.findIndex((s) => s.id === m.id) + 1 : 0;
  for (let i = live.length - 1; i >= keep; i -= 1) {
    try { live[i].handler.current?.(); } catch { /* a throwing close must not wedge Back */ }
  }
  // Give React a turn to unmount whatever really closed.
  setTimeout(reconcile, 0);
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('popstate', onPop, true);
}

/**
 * useBackToClose(enabled, onBack)
 * `onBack` runs when Back is pressed while this is the top sheet. Close the
 * sheet from it (or don't - see the header). Pass enabled = isMobile.
 */
export function useBackToClose(enabled, onBack) {
  const handler = useRef(onBack);
  useEffect(() => { handler.current = onBack; });
  // The component's identity, stable across StrictMode's effect re-run. Each
  // opening still gets its own id (`seq`): useId is derived from the tree
  // position, so a sheet closed and another opened in its place share one.
  const uid = useId();

  useEffect(() => {
    if (!enabled) return undefined;
    install();
    seq += 1;
    const sheet = { id: `${uid}#${seq}`, uid, path: window.location.pathname, handler };
    live.push(sheet);
    const top = markerOf(window.history.state);
    // Re-mounted with its own entry still on top (React StrictMode runs
    // effects twice in development): take that entry over rather than
    // pushing a second one.
    if (top && top.uid === uid && !isLive(top.id)) push(sheet, live.length, true);
    // Mid-traversal (a sheet just closed): pushing now would race it, so the
    // entry is added once it lands (reconcile).
    else if (pending === 0) push(sheet, live.length);
    return () => {
      const i = live.indexOf(sheet);
      if (i !== -1) live.splice(i, 1);
      // A microtask, so a StrictMode re-mount (or a sibling closing in the
      // same commit) is accounted for first.
      queueMicrotask(() => {
        // Already stepping back (another sheet closed in the same commit):
        // that traversal covers this entry too, and onPop walks on past any
        // stale entry it lands on.
        if (pending > 0) return;
        const m = markerOf(window.history.state);
        if (!m || isLive(m.id)) return;   // Back already took it, or an open sheet owns the top
        traverse(Math.max(1, m.idx - live.length));
      });
    };
  }, [enabled, uid]);
}

// For tests.
export function __resetBackToClose() {
  live.length = 0; pending = 0; pendingPath = null; clearTimeout(pendingTimer);
}
