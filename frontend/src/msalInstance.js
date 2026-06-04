import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './authConfig';

export const msalInstance = new PublicClientApplication(msalConfig);

// MSAL v3 requires explicit initialization before getAllAccounts()
// or acquireTokenSilent() can be called outside of React hooks.
// api.js awaits this before acquiring tokens.
export const msalReady = msalInstance.initialize();
