// Sign-in and identity for field offline (Neil, 11/03/2026; docs/Offline.md).
//
//   * Sign out (MSAL LOGOUT_START) or a different person -> the read cache is
//     cleared before anything else can show it. The outbox is NOT cleared:
//     an unsent change is the person's work, it stays on the phone under
//     their name and only ever sends, or shows, when they are signed in again.
//   * An Act As start / stop (api.js fires 'nexus:identity-change') clears the
//     read cache too; queued changes belong to the identity that made them.
//   * A sign-in (LOGIN_SUCCESS / ACQUIRE_TOKEN_SUCCESS) sends what parked on
//     a 401 - "Signed out - sign in when you have signal to send".
import { EventType } from '@azure/msal-browser';
import { msalInstance } from '../../msalInstance';
import { clearReadCache, checkIdentity } from './store';
import { afterSignIn, listEntries, isSignedOut } from './outbox';

let watching = false;

export function watchAuth() {
  if (watching) return;
  watching = true;
  try {
    msalInstance.addEventCallback((ev) => {
      const t = ev?.eventType;
      if (t === EventType.LOGOUT_START || t === EventType.LOGOUT_SUCCESS) clearReadCache();
      else if (t === EventType.LOGIN_SUCCESS) checkIdentity().then(() => afterSignIn());
      // A silent token refresh fires this on ordinary requests too - it only
      // matters while something is parked on a 401.
      else if (t === EventType.ACQUIRE_TOKEN_SUCCESS && isSignedOut()) afterSignIn();
    });
  } catch { /* no MSAL here (a public page) */ }
  if (typeof window !== 'undefined') {
    window.addEventListener('nexus:identity-change', () => {
      clearReadCache().then(() => checkIdentity()).then(() => listEntries()).catch(() => {});
    });
  }
}
