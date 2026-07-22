import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { msalConfig } from './authConfig';

export const msalInstance = new PublicClientApplication(msalConfig);

// ── Step-up re-auth return handler ────────────────────────────────────────────
// Step-up uses a full-page redirect (acquireTokenRedirect, prompt=login) — more
// reliable than popups, which hung in some browser setups. When the user returns
// from that redirect, MSAL fires a token-success event carrying a fresh ID token
// (with a recent auth_time). If a step-up was pending, hand that token to the
// backend (/stepup/verify) to open the session, then signal the UI. Registered
// here (module load) so it's active before any handleRedirectPromise resolves.
// A normal login redirect leaves the marker unset, so this stays inert for it.
msalInstance.addEventCallback((ev) => {
  const t = ev?.eventType;
  if ((t === EventType.ACQUIRE_TOKEN_SUCCESS || t === EventType.LOGIN_SUCCESS)
      && sessionStorage.getItem('nexus:stepup:pending') && ev.payload?.idToken) {
    sessionStorage.removeItem('nexus:stepup:pending');
    import('./api').then(({ api }) => api.stepupVerify(ev.payload.idToken)
      .then(() => window.dispatchEvent(new CustomEvent('nexus:stepup', { detail: { phase: 'verified' } })))
      .catch(() => window.dispatchEvent(new CustomEvent('nexus:stepup', { detail: { phase: 'end', ok: false, error: 'verify failed' } }))));
  }
});

// ── Dev login bypass ────────────────────────────────────────────────────────
// With `VITE_DEV_SKIP_AUTH=true` in a local .env.local, make the whole app see
// a synthetic signed-in account so `accounts[0]` resolves to the dev user
// everywhere (AuthenticatedTemplate gate, TopHeader/Sidebar identity,
// notifications, requisitions, RoleContext). Pairs with the backend's
// NEXUS_SKIP_AUTH identity — no Microsoft login required.
//
// Gated on `import.meta.env.DEV`, so it is entirely stripped from `vite build`:
// production always uses the real Microsoft login.
if (import.meta.env.DEV && import.meta.env.VITE_DEV_SKIP_AUTH === 'true') {
  const email = (import.meta.env.VITE_DEV_USER_EMAIL ?? 'dev@localhost').toLowerCase();
  const name  = import.meta.env.VITE_DEV_USER_NAME ?? email;
  const devAccount = {
    homeAccountId:  'dev-local.dev-tenant',
    localAccountId: 'dev-local',
    environment:    'login.microsoftonline.com',
    tenantId:       'dev-tenant',
    username:       email,
    name,
    idTokenClaims:  { preferred_username: email, name },
  };
  const realGetAll = msalInstance.getAllAccounts.bind(msalInstance);
  msalInstance.getAllAccounts = () => {
    const real = realGetAll();
    return real.length ? real : [devAccount];
  };
  const realGetActive = msalInstance.getActiveAccount.bind(msalInstance);
  msalInstance.getActiveAccount = () => realGetActive() ?? devAccount;
}

// MSAL v3 requires explicit initialization before getAllAccounts()
// or acquireTokenSilent() can be called outside of React hooks.
// api.js awaits this before acquiring tokens.
export const msalReady = msalInstance.initialize();
