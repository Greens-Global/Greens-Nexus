// BFF (Backend-For-Frontend) cookie-mode client helpers.
//
// When VITE_BFF_MODE=true the app authenticates with an HttpOnly server-side
// SESSION COOKIE instead of an MSAL Bearer token: api.js calls /api/* same-origin
// (the Cloudflare Pages Function proxies to the backend so the cookie is
// first-party), sends no token, and on 401 sends the browser to /api/auth/login.
//
// Default (flag off) = the existing MSAL/Bearer flow, entirely unchanged.
// See docs/BFF-Migration-Plan.md.
import { msalInstance } from './msalInstance';

// Cookie mode is decided at RUNTIME by hostname, not a build-time flag. Prod's
// bundle is built in GitHub Actions, which never receives VITE_BFF_MODE, so a
// build-time flag can't reach prod (setting it in the Cloudflare dashboard does
// nothing - that only feeds git-integrated builds like dev). So: the hosted app
// (dev + prod, both under *.nexus.greensglobal.com) is always cookie-mode;
// localhost and any other host stay on the MSAL/dev flow. An explicit
// VITE_BFF_MODE still overrides either way ('true' to force on, 'false' to force
// off as a rollback lever). See docs/BFF-Migration-Plan.md.
const _bffEnv = import.meta.env.VITE_BFF_MODE;
const _bffHosted = typeof location !== 'undefined'
  && /(^|\.)nexus\.greensglobal\.com$/.test(location.hostname || '');
export const BFF_MODE = _bffEnv === 'false' ? false : (_bffEnv === 'true' || _bffHosted);

// Identity resolved from the session at boot (email/role/level/csrf), or null.
let _me = null;
export function bffMe() { return _me; }

/** The readable (non-HttpOnly) CSRF cookie the login set, to echo on mutations. */
export function csrfToken() {
  const m = (typeof document !== 'undefined' ? document.cookie : '').match(/(?:^|;\s*)nx_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Set by bffLogout just before navigating away; read by bffLogin. localStorage
// so it is shared across TABS - the whole point (see bffLogin).
const SIGNED_OUT_KEY = 'nexus:signedout';
// Per-TAB flag (sessionStorage): marks the tab that INITIATED the logout, whose
// navigation to /api/auth/logout must never be hijacked. Other tabs don't have
// it and are safe to send to the sign-in screen.
const LOGOUT_TAB_KEY = 'nexus:loggingout';
const SIGNED_OUT_WINDOW_MS = 60_000;

export function clearSignedOutMarker() {
  try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* storage blocked */ }
  try { sessionStorage.removeItem(LOGOUT_TAB_KEY); } catch { /* storage blocked */ }
}

function _justSignedOut() {
  try { return Date.now() - Number(localStorage.getItem(SIGNED_OUT_KEY) || 0) < SIGNED_OUT_WINDOW_MS; }
  catch { return false; }
}

function _isLogoutTab() {
  try { return !!sessionStorage.getItem(LOGOUT_TAB_KEY); } catch { return false; }
}

// The instant someone logs out in ANY tab, every OTHER tab goes straight to the
// sign-in screen instead of sitting on a half-dead dashboard whose requests all
// 401 ("Missing or invalid Authorization header" strandings). The storage event
// only fires in tabs that did NOT write the key, so the logout tab's own
// navigation is never disturbed.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SIGNED_OUT_KEY && e.newValue && BFF_MODE && !_isLogoutTab()) {
      window.location.href = '/';
    }
  });
}

let _redirecting = false;
/** BFF's replacement for MSAL reauth: go to the server-side login, remembering
 *  where we were so the callback returns the user there.
 *
 *  Right after an EXPLICIT logout this must NOT run: any other open Nexus tab
 *  hits a 401 the moment the session dies, lands here, silently re-auths
 *  against the still-live (or half-dead) Microsoft SSO session, and mints a
 *  fresh cookie - resurrecting the user onto the dashboard they just logged
 *  out of. That race is why logout "worked sometimes": it depended on how many
 *  tabs were open. For a minute after logout, 401s route to the sign-in screen
 *  instead; the screen's own button (LoginPage) is explicit and always works. */
export function bffLogin() {
  if (_redirecting) return;
  if (_justSignedOut()) {
    _redirecting = true;   // swallow the repeat 401s that follow either way
    if (_isLogoutTab()) {
      // THIS tab's logout navigation is in motion - navigating anywhere here
      // hijacks it (the single-tab race: a background poll 401s mid-navigation,
      // auto-login wins, silently re-auths, user is back on the dashboard).
      // Do nothing; the logout completes and lands this tab on the sign-in page.
      return;
    }
    // A DIFFERENT tab logged out. This tab is dead weight - show the sign-in
    // screen instead of a stranded dashboard. (Normally the storage listener
    // already did this; this is the fallback for a 401 that raced it.)
    window.location.href = '/';
    return;
  }
  _redirecting = true;
  const next = encodeURIComponent(location.pathname + location.search);
  window.location.href = `/api/auth/login?next=${next}`;
}

/** Full sign-out: navigate to the server logout, which drops the session, ends
 *  the Entra SSO session, and lands back on the app (re-gated to a fresh login).
 *  A plain navigation (not fetch) so the browser follows the redirect chain to
 *  Microsoft - a POST that only cleared the cookie left the SSO session alive,
 *  so /auth/login silently re-authed and bounced the user right back in. */
export function bffLogout() {
  // Shared PC: wipe EVERYTHING this user cached in the browser before leaving, so
  // the next person to sign in on this machine can never see any of their data,
  // identity, prefs, or tokens. localStorage/sessionStorage are cleared
  // synchronously (removes MSAL accounts/tokens and every module cache); the
  // IndexedDB store is deleted fire-and-forget. The next login also re-purges on a
  // user change, so a session that ended without this (browser closed / crash) is
  // still covered.
  try { localStorage.clear(); } catch { /* storage blocked */ }
  try { sessionStorage.clear(); } catch { /* storage blocked */ }
  try { indexedDB.deleteDatabase('nexus_store'); } catch { /* ignore */ }
  // Re-set the markers the logout handoff itself needs, AFTER the wipe.
  try { sessionStorage.setItem(LOGOUT_TAB_KEY, '1'); } catch { /* storage blocked */ }
  try { localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* storage blocked */ }
  window.location.href = '/api/auth/logout';
}

/** Remove every browser-cached artifact of a PREVIOUS user - all localStorage and
 *  sessionStorage (module caches, prefs, MSAL accounts/tokens), the IndexedDB
 *  store, and any Cache Storage entries. Used when a DIFFERENT user signs in on a
 *  shared browser than last time, so nothing of the old user survives. */
async function _purgeClientData() {
  try { sessionStorage.clear(); } catch { /* blocked */ }
  try { localStorage.clear(); } catch { /* blocked */ }
  try { indexedDB.deleteDatabase('nexus_store'); } catch { /* ignore */ }
  try {
    if (typeof caches !== 'undefined') {
      const ks = await caches.keys();
      await Promise.all(ks.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
}

/** Make msalInstance report a SYNTHETIC account for the session user, so every
 *  part of the app that reads accounts[0] / getActiveAccount() (RoleContext, the
 *  header, people pickers) keeps working unchanged while auth actually rides the
 *  cookie. Same pattern as the dev-login bypass in msalInstance.js. */
function installSyntheticAccount(me) {
  const acct = {
    homeAccountId: 'bff.' + me.email,
    localAccountId: 'bff',
    environment: 'login.microsoftonline.com',
    tenantId: 'bff',
    username: me.email,
    name: me.name || me.email,
    idTokenClaims: { preferred_username: me.email, name: me.name || me.email },
  };
  // The COOKIE session is the source of truth for identity. Only ever expose an
  // MSAL account that belongs to the cookie user - never a real account left in
  // the cache by a PREVIOUS user on a shared PC. Without this, Aarav signing in
  // on Arnav's browser saw Arnav's name/avatar/greeting (accounts[0] returned
  // the stale real account) while the API correctly saw Aarav: a split-brain
  // identity. Filtering to the cookie email makes the synthetic account win when
  // the only real account is someone else's.
  const mine = (me.email || '').toLowerCase();
  const isMine = (a) => a && (a.username || '').toLowerCase() === mine;
  const realAll = msalInstance.getAllAccounts.bind(msalInstance);
  msalInstance.getAllAccounts = () => { const r = realAll().filter(isMine); return r.length ? r : [acct]; };
  const realActive = msalInstance.getActiveAccount.bind(msalInstance);
  msalInstance.getActiveAccount = () => { const a = realActive(); return isMine(a) ? a : acct; };
}

/** Evict any cached MSAL account that belongs to a DIFFERENT user than the cookie
 *  session (a previous user on this shared browser). Belt-and-suspenders on top of
 *  installSyntheticAccount's filter: it also removes the old user's tokens from
 *  this browser so nothing can silently acquire Graph tokens as them. */
async function _evictForeignAccounts(email) {
  try {
    const { msalReady } = await import('./msalInstance');
    await msalReady;
    const mine = (email || '').toLowerCase();
    const foreign = msalInstance.getAllAccounts().filter(a => (a.username || '').toLowerCase() !== mine);
    if (!foreign.length) return;
    for (const a of foreign) {
      try { await msalInstance.clearCache({ account: a }); } catch (_) { /* try the next */ }
    }
    // A stale msalprime marker for the old user is irrelevant; drop this user's so
    // priming their REAL account can run now instead of waiting out the 24h guard.
    try { localStorage.removeItem('nexus:msalprime:' + email); } catch (_) { /* storage blocked */ }
  } catch (_) { /* best-effort */ }
}

/** Get a REAL MSAL account into the cache for the cookie-session user.
 *  1st try: ssoSilent (hidden iframe, invisible). msal-browser v5's iframe
 *  monitor times out in Chrome here even though Entra answers in <1s
 *  (diagnosed live Aug 5), so it can't be the only path.
 *  Fallback: a ONE-TIME top-level loginRedirect with prompt=none - the same
 *  full-page mechanism the pre-BFF login used, immune to iframe issues. With
 *  a live Entra session it bounces out and back in about a second with no UI;
 *  MsalProvider processes the return and caches the account. Guarded so it
 *  can never loop: at most one attempt per user per browser per day, and only
 *  when no real account exists. */
async function _primeMsalAccount(email) {
  try {
    const { msalReady } = await import('./msalInstance');
    await msalReady;
    const { primeGraphSso } = await import('./teamsGraph');
    if (await primeGraphSso(email)) return;            // iframe path worked - done
    const key = 'nexus:msalprime:' + email;
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;  // already tried recently - never loop
    localStorage.setItem(key, String(Date.now()));
    const { loginRequest } = await import('./authConfig');
    await msalInstance.loginRedirect({ ...loginRequest, prompt: 'none', loginHint: email });
  } catch { /* priming is best-effort - Teams posts degrade to "not sent", nothing else */ }
}

/** Resolve identity from the session before the app renders. Returns whether to
 *  render: false only when we're redirecting to login (page is navigating away).
 *  On a transient error we still render - the app's own calls will 401-redirect
 *  if we're genuinely unauthenticated, so a backend blip never white-screens. */
export async function bffBootstrap() {
  // Retry across a backend blip (deploy/restart) so a TRANSIENT failure never
  // bounces a logged-in user to the sign-in screen. Only a real 401 (genuinely
  // signed out) returns false immediately; 5xx/network keep retrying.
  const delaysMs = [0, 800, 1500, 2500, 4000, 6000, 8000];   // ~23s - outlasts a slot-swap deploy
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i]) await new Promise(r => setTimeout(r, delaysMs[i]));
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        _me = await res.json();
        if (_me && _me.email) {
          // Shared PC: if a DIFFERENT user is signing in than last time on this
          // browser, purge the previous user's cached data/prefs/tokens BEFORE the
          // app reads any of it. Catches sessions that ended without a clean logout
          // (browser closed, crash). First-ever login (no prior) purges nothing.
          try {
            const prev = (localStorage.getItem('nexus:lastEmail') || '').toLowerCase();
            if (prev && prev !== _me.email.toLowerCase()) await _purgeClientData();
          } catch { /* best-effort */ }
          // Remembered for the NEXT sign-in: passed as login_hint so Entra
          // preselects this account instead of showing the picker.
          try { localStorage.setItem('nexus:lastEmail', _me.email); } catch { /* storage blocked */ }
          // Signed in successfully - any leftover logout markers are stale.
          clearSignedOutMarker();
          // Shared PC: drop a previous user's cached MSAL account/tokens BEFORE we
          // expose accounts, so the new user never inherits the old identity.
          await _evictForeignAccounts(_me.email);
          installSyntheticAccount(_me);
          // Background: turn the live Entra SSO session into a REAL cached MSAL
          // account so Graph calls - the Teams BOD/EOD post, chat lists - work
          // silently later. Without this, cookie logins have no MSAL cache
          // entry and every Graph call dead-ends. Fire-and-forget: boot never
          // waits on it (it may navigate the page - see _primeMsalAccount).
          _primeMsalAccount(_me.email);
          return true;
        }
        return false;   // 200 but no identity -> treat as anonymous
      }
      if (res.status === 401) return false;   // genuinely signed out -> login screen
      // 5xx / other -> backend still coming up, keep retrying
    } catch { /* network error -> backend unreachable, keep retrying */ }
  }
  return false;   // still failing after all retries -> fall back to the login screen
}
