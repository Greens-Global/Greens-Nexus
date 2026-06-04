import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './authConfig';

// Shared instance — imported by both main.jsx and api.js
export const msalInstance = new PublicClientApplication(msalConfig);
