import { useState, useEffect } from 'react';
import { Sunrise, Sunset, Coffee, X, Send, Loader2, Link2 as LinkIcon } from 'lucide-react';
import { msalInstance } from '../msalInstance';
import { api } from '../api';

// ── Beginning / End-of-day / Break message ────────────────────────────────────
// BOD shows on the FIRST punch-in (plan + today's tasks); EOD on punch-out (what
// got done); BREAK when stepping away ("I'm on a break for …"). The message posts
// to a Teams GROUP CHAT from the employee's OWN ACCOUNT (delegated Graph — the
// browser asks consent the first time) and a copy is recorded in Nexus.
// Each prompt can be skipped only by ticking "I already sent this" (so people who
// posted it manually aren't nagged, but nobody silently skips).

const MODES = {
  bod: {
    title: 'Beginning of day', Icon: Sunrise, color: '#f59e0b', tag: 'BOD',
    sub: "First punch-in today — tell the team what's on your plate.",
    msgLabel: 'Message', msgPlaceholder: 'Good morning! Starting my day…',
    tasksLabel: "Today's tasks (one per line)", tasksHead: 'Tasks',
    tasksPlaceholder: 'Finish the Lakeline report\nCall the Riverside vendor\nReview Q2 numbers',
    cta: 'Send & start the day', ackLabel: 'I already sent my login (BOD) message',
  },
  eod: {
    title: 'End of day', Icon: Sunset, color: '#7c3aed', tag: 'EOD',
    sub: 'Wrapping up — post your summary and the tasks you worked on.',
    msgLabel: 'Summary', msgPlaceholder: 'Wrapping up — good progress today.',
    tasksLabel: 'Tasks (one per line)', tasksHead: 'Tasks',
    tasksPlaceholder: 'Lakeline report\nRiverside vendor call\nQ2 numbers review',
    cta: 'Send & clock out', ackLabel: 'I already sent my logout (EOD) message',
  },
  break: {
    title: 'Going on break', Icon: Coffee, color: '#b45309', tag: 'BREAK', reasonOnly: true,
    sub: 'Let the team know — this posts "I\'m on a break for …" to your chat.',
    msgLabel: 'Reason', msgPlaceholder: 'Lunch',
    cta: 'Start break & notify', ackLabel: 'I already told my team',
  },
};

const GRAPH_SCOPES = ['Chat.ReadBasic', 'ChatMessage.Send'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

// group-chat list cached for the session so reopening the modal is instant.
let cachedChats = null;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function graphTokenSilent() {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await withTimeout(msalInstance.acquireTokenSilent({ scopes: GRAPH_SCOPES, account }), 6000);
    return r.accessToken;
  } catch { return null; }
}

async function graphTokenInteractive() {
  const account = msalInstance.getAllAccounts()[0];
  return (await msalInstance.acquireTokenPopup({ scopes: GRAPH_SCOPES, account })).accessToken;
}

async function graphJSON(url, tok, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function chatName(c, myId) {
  if (c.topic) return c.topic;
  const others = (c.members || []).filter(m => m.userId && m.userId !== myId)
    .map(m => m.displayName).filter(Boolean);
  if (others.length) return others.join(', ');
  return c.chatType === 'oneOnOne' ? 'Direct chat' : 'Group chat';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

export default function BodModal({ mode = 'bod', required = false, onSent, onSkip, onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [chats, setChats] = useState(cachedChats);   // null until loaded
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ack, setAck] = useState(false);
  const myId = msalInstance.getAllAccounts()[0]?.localAccountId;

  async function prefillLast(list) {
    const last = await api.timeBodLast().catch(() => null);
    if (last?.channelId && list.some(c => c.id === last.channelId)) setChatId(last.channelId);
    else if (list.length === 1) setChatId(list[0].id);
  }

  async function loadChats(tok) {
    const data = await graphJSON(`${GRAPH}/me/chats?$expand=members&$top=50`, tok);
    let list = (data?.value || []).map(c => ({ id: c.id, chatType: c.chatType, name: chatName(c, myId) }));
    // group chats first (that's what these messages are for), then the rest
    list.sort((a, b) => (a.chatType === 'group' ? 0 : 1) - (b.chatType === 'group' ? 0 : 1));
    cachedChats = list; setChats(list);
    prefillLast(list);
    return list;
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (cachedChats) { setChats(cachedChats); prefillLast(cachedChats); return; }
      setLoading(true);
      const tok = await graphTokenSilent();
      if (!live) return;
      if (!tok) { setNeedsConnect(true); setLoading(false); return; }
      await loadChats(tok);
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  async function connectTeams() {
    setConnecting(true);
    try {
      const tok = await graphTokenInteractive();
      setNeedsConnect(false); setLoading(true);
      await loadChats(tok);
    } catch {
      toastErr('Could not connect Teams — you can still Send to record it in Nexus.');
    } finally { setConnecting(false); setLoading(false); }
  }

  function buildHtml() {
    if (M.reasonOnly) return `I'm on a break${message.trim() ? ` for ${esc(message.trim())}` : ''}.`;
    const taskLines = tasks.split('\n').map(t => t.trim()).filter(Boolean);
    return `<b>${M.tag}:</b> ${esc(message)}`
      + (taskLines.length ? `<br/><br/><b>${M.tasksHead}</b><br/>${taskLines.map(t => `• ${esc(t)}`).join('<br/>')}` : '');
  }

  async function send() {
    if (busy) return;
    if (!message.trim()) { toastErr(M.reasonOnly ? 'Add a short reason.' : `Write a short ${M.title.toLowerCase()} message.`); return; }
    setBusy(true);
    const chat = (chats || []).find(c => c.id === chatId);
    let sent = false, sendError = '';
    if (chatId) {
      try {
        const tok = (await graphTokenSilent()) || (await graphTokenInteractive().catch(() => null));
        if (!tok) throw new Error('Teams not connected');
        const r = await fetch(`${GRAPH}/chats/${chatId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'html', content: buildHtml() } }),
        });
        if (r.ok) sent = true;
        else sendError = `Graph ${r.status}: ${(await r.text()).slice(0, 180)}`;
      } catch (e) { sendError = String(e?.message || e).slice(0, 180); }
    } else sendError = 'No chat selected';
    try {
      await api.timeBodRecord({
        kind: mode, message, tasks, channel_id: chatId, channel_name: chat?.name || '',
        sent, send_error: sent ? '' : sendError, tz_offset_min: new Date().getTimezoneOffset(),
      });
    } catch { /* the Teams post is the user-visible outcome */ }
    if (sent) toastOk(`Posted to ${chat?.name || 'your chat'} and recorded.`);
    else toastErr(`Recorded in Nexus, but the Teams post failed${sendError ? ` — ${sendError}` : ''}.`);
    setBusy(false);
    if (onSent) onSent(); else onClose();
  }

  const skip = () => (onSkip ? onSkip() : onClose());

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1420, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !required) onClose(); }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '15px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <M.Icon size={17} style={{ color: M.color }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{M.title}</h3>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{M.sub}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: '16px 22px', display: 'grid', gap: 12 }}>
          <div>
            <label style={FL}>{M.msgLabel}</label>
            <textarea className="form-input" rows={M.reasonOnly ? 2 : 2} value={message} onChange={e => setMessage(e.target.value)}
              placeholder={M.msgPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          {!M.reasonOnly && (
            <div>
              <label style={FL}>{M.tasksLabel}</label>
              <textarea className="form-input" rows={4} value={tasks} onChange={e => setTasks(e.target.value)}
                placeholder={M.tasksPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
            </div>
          )}
          {/* Post to a Teams group chat, or just record in Nexus */}
          <div>
            <label style={FL}>Post to a group chat <span style={{ textTransform: 'none', fontWeight: 500 }}>(optional)</span></label>
            {needsConnect ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="secondary-btn" onClick={connectTeams} disabled={connecting}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  {connecting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LinkIcon size={13} />}
                  Connect Teams
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>one-time — or just Send to record it in Nexus.</span>
              </div>
            ) : loading ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading your chats…
              </div>
            ) : (
              <select className="form-input" value={chatId} onChange={e => setChatId(e.target.value)} style={{ width: '100%', fontSize: 12.5 }}>
                <option value="">— pick a group chat —</option>
                {(chats || []).map(c => <option key={c.id} value={c.id}>{c.name}{c.chatType === 'oneOnOne' ? ' (direct)' : ''}</option>)}
              </select>
            )}
          </div>
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center' }}>
          {required && M.ackLabel && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', flex: 1 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
              {M.ackLabel}
            </label>
          )}
          <div style={{ flex: required && M.ackLabel ? 'none' : 1 }} />
          <button className="secondary-btn" onClick={skip} disabled={required && !ack}
            title={required && !ack ? 'Tick the box above if you already sent it' : ''}>Skip</button>
          <button className="primary-btn" onClick={send} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} {M.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
