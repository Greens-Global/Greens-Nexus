import { useState, useEffect } from 'react';
import { Sunrise, Sunset, X, Send, Loader2, Link2 as LinkIcon } from 'lucide-react';
import { msalInstance } from '../msalInstance';
import { api } from '../api';

// ── Beginning / End-of-day message ────────────────────────────────────────────
// BOD shows on the FIRST punch-in (plan + today's tasks); EOD shows on punch-out
// (summary + what got done / blockers). Either way the employee picks a Teams
// channel and the message posts to it FROM THEIR OWN ACCOUNT (delegated Graph —
// the browser asks for consent the first time). A copy is recorded in Nexus.

const MODES = {
  bod: {
    title: 'Beginning of day', Icon: Sunrise, color: '#f59e0b', tag: 'BOD',
    sub: "First punch-in today — tell the team what's on your plate. Sent from your account.",
    msgLabel: 'Message', msgPlaceholder: 'Good morning! Starting my day…',
    tasksLabel: "Today's tasks (one per line)", tasksHead: 'Tasks',
    tasksPlaceholder: 'Finish the Lakeline report\nCall the Riverside vendor\nReview Q2 numbers',
    cta: 'Send & start the day',
  },
  eod: {
    title: 'End of day', Icon: Sunset, color: '#7c3aed', tag: 'EOD',
    sub: 'Wrapping up — post your summary and the tasks you worked on. Sent from your account.',
    msgLabel: 'Summary', msgPlaceholder: 'Wrapping up — good progress today.',
    tasksLabel: 'Tasks (one per line)', tasksHead: 'Tasks',
    tasksPlaceholder: 'Lakeline report\nRiverside vendor call\nQ2 numbers review',
    cta: 'Send & clock out',
  },
};

const GRAPH_SCOPES = ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

// joined-teams list cached for the session so reopening the modal is instant.
let cachedTeams = null;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// Silent only, fails fast — never hangs the modal. Returns null if a login popup
// would be needed (we surface a "Connect Teams" button for that instead).
async function graphTokenSilent() {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await withTimeout(msalInstance.acquireTokenSilent({ scopes: GRAPH_SCOPES, account }), 6000);
    return r.accessToken;
  } catch { return null; }
}

// Interactive — only ever called from a user click (popups need a gesture).
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

export default function BodModal({ mode = 'bod', required = false, onSent, onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [teams, setTeams] = useState(cachedTeams);   // null until loaded
  const [channels, setChannels] = useState([]);
  const [teamId, setTeamId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);

  async function prefillLast(list) {
    const last = await api.timeBodLast().catch(() => null);
    if (last?.teamId && list.some(t => t.id === last.teamId)) {
      setTeamId(last.teamId); setChannelId(last.channelId || '');
    } else if (list.length === 1) setTeamId(list[0].id);
  }

  async function loadTeams(tok) {
    const data = await graphJSON(`${GRAPH}/me/joinedTeams?$select=id,displayName`, tok);
    const list = data?.value || [];
    cachedTeams = list; setTeams(list);
    prefillLast(list);
    return list;
  }

  // On open: use the cache, else try a fast SILENT token. If that can't get one
  // (needs consent/login), show a Connect button — never block on a popup here.
  useEffect(() => {
    let live = true;
    (async () => {
      if (cachedTeams) { setTeams(cachedTeams); prefillLast(cachedTeams); return; }
      setLoadingTeams(true);
      const tok = await graphTokenSilent();
      if (!live) return;
      if (!tok) { setNeedsConnect(true); setLoadingTeams(false); return; }
      await loadTeams(tok);
      if (live) setLoadingTeams(false);
    })();
    return () => { live = false; };
  }, []);

  async function connectTeams() {
    setConnecting(true);
    try {
      const tok = await graphTokenInteractive();
      setNeedsConnect(false); setLoadingTeams(true);
      await loadTeams(tok);
    } catch (e) {
      toastErr('Could not connect Teams — you can still Send to record it in Nexus.');
    } finally { setConnecting(false); setLoadingTeams(false); }
  }

  useEffect(() => {
    if (!teamId) { setChannels([]); return; }
    let live = true;
    (async () => {
      const tok = await graphTokenSilent();
      if (!tok || !live) return;
      const data = await graphJSON(`${GRAPH}/teams/${teamId}/channels?$select=id,displayName`, tok);
      if (!live) return;
      const list = data?.value || [];
      setChannels(list);
      setChannelId(c => (list.some(x => x.id === c) ? c : (list[0]?.id || '')));
    })();
    return () => { live = false; };
  }, [teamId]);

  async function send() {
    if (busy) return;
    if (!message.trim()) { toastErr(`Write a short ${M.title.toLowerCase()} message.`); return; }
    setBusy(true);
    const team = teams?.find(t => t.id === teamId);
    const channel = channels.find(c => c.id === channelId);
    let sent = false, sendError = '';
    if (teamId && channelId) {
      try {
        const tok = (await graphTokenSilent()) || (await graphTokenInteractive().catch(() => null));
        if (!tok) throw new Error('Teams not connected');
        const taskLines = tasks.split('\n').map(t => t.trim()).filter(Boolean);
        const html = `<b>${M.tag}:</b> ${esc(message)}`
          + (taskLines.length ? `<br/><br/><b>${M.tasksHead}</b><br/>${taskLines.map(t => `• ${esc(t)}`).join('<br/>')}` : '');
        const r = await fetch(`${GRAPH}/teams/${teamId}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'html', content: html } }),
        });
        if (r.ok) sent = true;
        else sendError = `Graph ${r.status}: ${(await r.text()).slice(0, 180)}`;
      } catch (e) { sendError = String(e?.message || e).slice(0, 180); }
    } else sendError = 'No channel selected';
    try {
      await api.timeBodRecord({
        kind: mode, message, tasks, team_id: teamId, team_name: team?.displayName || '',
        channel_id: channelId, channel_name: channel?.displayName || '',
        sent, send_error: sent ? '' : sendError,
        tz_offset_min: new Date().getTimezoneOffset(),
      });
    } catch { /* the Teams post is the user-visible outcome */ }
    if (sent) toastOk(`Posted to ${team?.displayName} › ${channel?.displayName} and recorded.`);
    else toastErr(`Recorded in Nexus, but the Teams post failed${sendError ? ` — ${sendError}` : ''}.`);
    setBusy(false);
    if (onSent) onSent(); else onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1420, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !required) onClose(); }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '15px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <M.Icon size={17} style={{ color: M.color }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{M.title}</h3>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>
              {required ? 'Required before you punch in — send this to start your shift.' : M.sub}
            </p>
          </div>
          {!required && <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>}
        </div>

        <div style={{ padding: '16px 22px', display: 'grid', gap: 12 }}>
          <div>
            <label style={FL}>{M.msgLabel}</label>
            <textarea className="form-input" rows={2} value={message} onChange={e => setMessage(e.target.value)}
              placeholder={M.msgPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          <div>
            <label style={FL}>{M.tasksLabel}</label>
            <textarea className="form-input" rows={4} value={tasks} onChange={e => setTasks(e.target.value)}
              placeholder={M.tasksPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          {/* Teams channel — post to a channel, or just record in Nexus */}
          <div>
            <label style={FL}>Post to Teams <span style={{ textTransform: 'none', fontWeight: 500 }}>(optional)</span></label>
            {needsConnect ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="secondary-btn" onClick={connectTeams} disabled={connecting}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  {connecting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LinkIcon size={13} />}
                  Connect Teams
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>one-time — or just Send to record it in Nexus.</span>
              </div>
            ) : loadingTeams ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading your teams…
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <select className="form-input" value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: '100%', fontSize: 12.5 }}>
                  <option value="">— team —</option>
                  {(teams || []).map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                </select>
                <select className="form-input" value={channelId} onChange={e => setChannelId(e.target.value)} disabled={!channels.length} style={{ width: '100%', fontSize: 12.5 }}>
                  {!channels.length && <option value="">— channel —</option>}
                  {channels.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>{required ? 'Cancel' : 'Skip'}</button>
          <button className="primary-btn" onClick={send} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} {M.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
