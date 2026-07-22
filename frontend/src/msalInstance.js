import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './authConfig';

export const msalInstance = new PublicClientApplication(msalConfig);

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
