import { msalInstance } from './msalInstance';
import { popupRedirectUri } from './authConfig';

// ── Shared Microsoft Graph helpers for Teams group chats ──────────────────────
// Used by the message modal (BodModal) and the admin group→chat binding UI.
// Delegated Graph: reads the signed-in user's chats and posts AS them.

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const CHAT_SCOPES = ['Chat.ReadBasic', 'ChatMessage.Send'];

export function myGraphId() {
  return msalInstance.getAllAccounts()[0]?.localAccountId;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// Cookie-mode logins install a SYNTHETIC account (bffAuth.js) so the UI works
// without MSAL - but it has no entry in MSAL's token cache, so passing it to
// acquireToken* fails. Only a REAL cached account can mint tokens silently.
function realAccount() {
  return msalInstance.getAllAccounts().find(a => a.localAccountId !== 'bff' && a.localAccountId !== 'dev-local') || null;
}

/** One-shot ssoSilent: turn the browser's live Entra SSO session into a REAL
 *  cached MSAL account for the signed-in email. Safe to call repeatedly (no-op
 *  once a real account exists); never throws. Called from bffBootstrap at app
 *  boot so tokens are ready long before anyone punches out. */
let _ssoPrimed = null;
export function primeGraphSso(loginHint) {
  if (realAccount()) return Promise.resolve(true);
  if (_ssoPrimed) return _ssoPrimed;
  _ssoPrimed = withTimeout(msalInstance.ssoSilent({ scopes: CHAT_SCOPES, loginHint }), 10000)
    .then(() => true)
    .catch(() => { _ssoPrimed = null; return false; });   // retry allowed on next call
  return _ssoPrimed;
}

// Silent only, fails fast - never hangs the UI, never pops a login. Punch-out
// and BOD/EOD posts use ONLY this: a sign-in prompt must never gate a punch.
export async function graphTokenSilent() {
  let account = realAccount();
  if (!account) {
    // Cache not primed yet (first run after a cookie login) - try turning the
    // Entra SSO session into an account now, still fully silent.
    const hint = msalInstance.getAllAccounts()[0]?.username;
    if (hint) await primeGraphSso(hint);
    account = realAccount();
    if (!account) return null;
  }
  try {
    const r = await withTimeout(msalInstance.acquireTokenSilent({ scopes: CHAT_SCOPES, account }), 6000);
    return r.accessToken;
  } catch { return null; }
}

// Interactive - only ever from a deliberate user click on a settings/connect
// surface (admin chat binding, Testing), never from the punch flow. Redirects
// the popup to the blank auth-popup.html page so the SPA can't boot inside it.
export async function graphTokenInteractive() {
  const account = realAccount();
  const req = { scopes: CHAT_SCOPES, redirectUri: popupRedirectUri };
  if (account) req.account = account;
  else {
    const hint = msalInstance.getAllAccounts()[0]?.username;
    if (hint) req.loginHint = hint;
  }
  return (await msalInstance.acquireTokenPopup(req)).accessToken;
}

// Token for the SEND path: silent only, by design. If Teams isn't silently
// reachable the caller records the action in Nexus and reports "not sent" -
// it must never interrupt a punch with a Microsoft sign-in window.
export async function graphToken() {
  return await graphTokenSilent();
}

export async function graphJSON(url, tok, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export function chatLabel(c, myId) {
  if (c.topic) return c.topic;
  const others = (c.members || []).filter(m => m.userId && m.userId !== myId)
    .map(m => m.displayName).filter(Boolean);
  if (others.length) return others.join(', ');
  return c.chatType === 'oneOnOne' ? 'Direct chat' : 'Group chat';
}

// Returns [{ id, chatType, name }], group chats first.
export async function listMyChats(tok) {
  const myId = myGraphId();
  const data = await graphJSON(`${GRAPH}/me/chats?$expand=members&$top=50`, tok);
  const list = (data?.value || []).map(c => ({ id: c.id, chatType: c.chatType, name: chatLabel(c, myId) }));
  list.sort((a, b) => (a.chatType === 'group' ? 0 : 1) - (b.chatType === 'group' ? 0 : 1));
  return list;
}

export async function postChatMessage(tok, chatId, html) {
  const r = await fetch(`${GRAPH}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'html', content: html } }),
  });
  if (!r.ok) throw new Error(`Graph ${r.status}: ${(await r.text()).slice(0, 180)}`);
  return true;
}
