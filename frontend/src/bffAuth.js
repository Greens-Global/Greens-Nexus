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

let _redirecting = false;
/** BFF's replacement for MSAL reauth: go to the server-side login, remembering
 *  where we were so the callback returns the user there. */
export function bffLogin() {
  if (_redirecting) return;
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
  window.location.href = '/api/auth/logout';
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
  const realAll = msalInstance.getAllAccounts.bind(msalInstance);
  msalInstance.getAllAccounts = () => { const r = realAll(); return r.length ? r : [acct]; };
  const realActive = msalInstance.getActiveAccount.bind(msalInstance);
  msalInstance.getActiveAccount = () => realActive() ?? acct;
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
