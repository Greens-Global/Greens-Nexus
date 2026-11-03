// Who the phone's offline data belongs to (field offline, Neil 11/03/2026).
//
// The signed-in Microsoft account (MSAL - in BFF mode bffBootstrap installs
// the same synthetic account) plus the Act As session when one is on. Every
// cached dataset and every queued change is stamped with this key; a read for
// another key finds nothing and a queued change only ever sends as the person
// who made it - a shared crew tablet never shows one person's jobs to the
// next, and an administrator's Act As never mixes with their own data.
import { msalInstance } from '../../msalInstance';
import { getActAsSessionId } from '../../api';

let override;   // undefined = read MSAL; null = nobody (tests); an identity (tests)

/** { email, actAs, key } or null when nobody is signed in. */
export function currentIdentity() {
  if (override !== undefined) return override;
  let email;
  try {
    const acct = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    email = String(acct?.username || acct?.idTokenClaims?.preferred_username || '').trim().toLowerCase();
  } catch { email = ''; }
  if (!email && import.meta.env.VITE_E2E === 'true') email = 'e2e@local';
  if (!email) return null;
  let actAs;
  try { actAs = getActAsSessionId() || ''; } catch { actAs = ''; }
  return { email, actAs, key: `${email}|${actAs}` };
}

export const identityKey = () => currentIdentity()?.key || '';

/** Test seam: pin the identity ({ email, actAs } or null), undefined to unpin. */
export function _setIdentity(id) {
  override = id ? { email: id.email, actAs: id.actAs || '', key: `${id.email}|${id.actAs || ''}` } : id;
}
