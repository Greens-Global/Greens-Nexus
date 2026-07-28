import { msalInstance } from './msalInstance';

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

// Silent only, fails fast - never hangs the UI. null if a login popup is needed.
export async function graphTokenSilent() {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await withTimeout(msalInstance.acquireTokenSilent({ scopes: CHAT_SCOPES, account }), 6000);
    return r.accessToken;
  } catch { return null; }
}

// Interactive - only ever from a user click (popups need a gesture).
export async function graphTokenInteractive() {
  const account = msalInstance.getAllAccounts()[0];
  return (await msalInstance.acquireTokenPopup({ scopes: CHAT_SCOPES, account })).accessToken;
}

// A silent token if we have one, otherwise an interactive popup. For send/list.
export async function graphToken() {
  return (await graphTokenSilent()) || (await graphTokenInteractive().catch(() => null));
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
