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

export const BFF_MODE = import.meta.env.VITE_BFF_MODE === 'true';

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

/** Resolve identity from the session before the app renders. Returns whether to
 *  render: false only when we're redirecting to login (page is navigating away).
 *  On a transient error we still render - the app's own calls will 401-redirect
 *  if we're genuinely unauthenticated, so a backend blip never white-screens. */
export async function bffBootstrap() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      _me = await res.json();
      if (_me && _me.email) { installSyntheticAccount(_me); return true; }
    }
  } catch { /* network blip -> treat as anonymous, show the sign-in landing */ }
  return false;   // no session (401) or transient -> main.jsx renders LandingPage
}
