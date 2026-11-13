// How the installed app is told what to start with (the manifest's
// shortcuts and share_target, public/manifest.webmanifest).
//
//   /?do=new-task     the New Task shortcut   -> the bolt's New Task
//   /?do=new-ticket   the New Ticket shortcut -> the bolt's New Ticket
//   /?share=1         Share to Nexus (public/sw.js sends the share here)
//
// The address is read ONCE, when this module loads - before sign-in can send
// the browser to Microsoft and back - kept for this tab (sessionStorage, so
// it survives that round trip and nothing else) and taken off the address,
// so a reload or a copied link never starts it again. components/
// InstalledApp.jsx takes it after sign-in: an action runs through
// lib/quickCreate.js (the same Quick Action the bolt runs - a person who
// cannot use it simply lands on the Dashboard), a share opens the Share to
// Nexus sheet. A launch nobody took within ten minutes is dropped.
const KEY = 'nx-app-launch';
const MAX_AGE_MS = 10 * 60 * 1000;

// ?do=<value> -> the Quick Action key (lib/quickCreate.js ACTIONS).
export const LAUNCH_ACTIONS = { 'new-task': 'task', 'new-ticket': 'ticket' };

/** { action, share } from an address's query, or null when it asks for nothing. */
export function parseLaunch(search) {
  let params;
  try { params = new URLSearchParams(search || ''); } catch { return null; }
  const action = Object.hasOwn(LAUNCH_ACTIONS, params.get('do') || '') ? LAUNCH_ACTIONS[params.get('do')] : '';
  const share = params.get('share') === '1';
  return action || share ? { action, share } : null;
}

/** Read the launch off the address, keep it for this tab and clean the address. */
export function captureLaunch(win = typeof window !== 'undefined' ? window : null, now = Date.now()) {
  if (!win) return null;
  let url;
  try { url = new URL(win.location.href); } catch { return null; }
  // Only OUR values are taken: ?do= is also the Time Sheet link's
  // (?start=&type=&do=submit) and must reach that screen untouched.
  const launch = parseLaunch(url.search);
  if (!launch) return null;
  try { win.sessionStorage.setItem(KEY, JSON.stringify({ ...launch, at: now })); } catch { /* storage off: this launch is lost, the app still opens */ }
  if (launch.action) url.searchParams.delete('do');
  if (launch.share) url.searchParams.delete('share');
  try { win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* the address keeps the param; it is only read here */ }
  return launch;
}

function readKept(win, now, remove) {
  if (!win) return null;
  let raw;
  try {
    raw = win.sessionStorage.getItem(KEY);
    if (raw && remove) win.sessionStorage.removeItem(KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !(now - Number(v.at) <= MAX_AGE_MS)) return null;
    const action = Object.values(LAUNCH_ACTIONS).includes(v.action) ? v.action : '';
    return action || v.share === true ? { action, share: v.share === true } : null;
  } catch { return null; }
}

/** The launch waiting in this tab, left where it is: { action, share } or null. */
export function peekLaunch(win = typeof window !== 'undefined' ? window : null, now = Date.now()) {
  return readKept(win, now, false);
}

/** The launch waiting in this tab - handed over once: { action, share } or null. */
export function takeLaunch(win = typeof window !== 'undefined' ? window : null, now = Date.now()) {
  return readKept(win, now, true);
}

captureLaunch();
