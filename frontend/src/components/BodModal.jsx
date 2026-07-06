import { useState, useEffect } from 'react';
import { Sunrise, Sunset, X, Send, Loader2 } from 'lucide-react';
import { msalInstance } from '../msalInstance';
import { api } from '../api';

// ── Beginning / End-of-day message ────────────────────────────────────────────
// BOD shows on the FIRST punch-in (plan + today's tasks); EOD shows on punch-out
// (summary + what got done / blockers). Either way the employee picks a Teams
// channel and the message posts to it FROM THEIR OWN ACCOUNT (delegated Graph —
// the browser asks for consent the first time). A copy is recorded in Nexus.

const MODES = {
  bod: {
    title: 'Beginning of day', Icon: Sunrise, color: '#f59e0b', emoji: '🌅',
    sub: "First punch-in today — tell the team what's on your plate. Sent from your account.",
    msgLabel: 'Message', msgPlaceholder: 'Good morning! Starting my day…',
    tasksLabel: "Today's tasks (one per line)", tasksHead: "Today's tasks",
    tasksPlaceholder: 'Finish the Lakeline report\nCall the Riverside vendor',
    cta: 'Send & start the day',
  },
  eod: {
    title: 'End of day', Icon: Sunset, color: '#7c3aed', emoji: '🌇',
    sub: "Wrapping up — post a quick summary of your day. Sent from your account.",
    msgLabel: 'Summary', msgPlaceholder: 'Wrapping up for the day — good progress overall.',
    tasksLabel: 'What got done / blockers (one per line)', tasksHead: 'Today',
    tasksPlaceholder: 'Shipped the Lakeline report\nBlocked on Riverside vendor callback',
    cta: 'Send & clock out',
  },
};

const GRAPH_SCOPES = ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphToken() {
  const account = msalInstance.getAllAccounts()[0];
  try {
    return (await msalInstance.acquireTokenSilent({ scopes: GRAPH_SCOPES, account })).accessToken;
  } catch {
    return (await msalInstance.acquireTokenPopup({ scopes: GRAPH_SCOPES, account })).accessToken;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

export default function BodModal({ mode = 'bod', onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [teams, setTeams] = useState(null);       // null = loading Graph
  const [channels, setChannels] = useState([]);
  const [teamId, setTeamId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [graphErr, setGraphErr] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const tok = await graphToken();
        const r = await fetch(`${GRAPH}/me/joinedTeams?$select=id,displayName`, { headers: { Authorization: `Bearer ${tok}` } });
        if (!r.ok) throw new Error(`Teams list failed (${r.status})`);
        const list = (await r.json()).value || [];
        if (!live) return;
        setTeams(list);
        const last = await api.timeBodLast().catch(() => null);
        if (!live) return;
        if (last?.teamId && list.some(t => t.id === last.teamId)) {
          setTeamId(last.teamId);
          setChannelId(last.channelId || '');
        } else if (list.length === 1) setTeamId(list[0].id);
      } catch (e) {
        if (live) { setTeams([]); setGraphErr(e?.message || 'Could not reach Teams.'); }
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!teamId) { setChannels([]); return; }
    let live = true;
    (async () => {
      try {
        const tok = await graphToken();
        const r = await fetch(`${GRAPH}/teams/${teamId}/channels?$select=id,displayName`, { headers: { Authorization: `Bearer ${tok}` } });
        const list = r.ok ? (await r.json()).value || [] : [];
        if (!live) return;
        setChannels(list);
        setChannelId(c => (list.some(x => x.id === c) ? c : (list[0]?.id || '')));
      } catch { if (live) setChannels([]); }
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
        const tok = await graphToken();
        const taskLines = tasks.split('\n').map(t => t.trim()).filter(Boolean);
        const html = `<b>${M.emoji} ${M.title}</b><br/>${esc(message)}`
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
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1420, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
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
            <textarea className="form-input" rows={2} value={message} onChange={e => setMessage(e.target.value)}
              placeholder={M.msgPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          <div>
            <label style={FL}>{M.tasksLabel}</label>
            <textarea className="form-input" rows={4} value={tasks} onChange={e => setTasks(e.target.value)}
              placeholder={M.tasksPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={FL}>Team</label>
              {teams === null
                ? <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Loading your teams…</div>
                : <select className="form-input" value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: '100%', fontSize: 12.5 }}>
                    <option value="">— pick a team —</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
                  </select>}
            </div>
            <div>
              <label style={FL}>Channel</label>
              <select className="form-input" value={channelId} onChange={e => setChannelId(e.target.value)} disabled={!channels.length} style={{ width: '100%', fontSize: 12.5 }}>
                {!channels.length && <option value="">—</option>}
                {channels.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
              </select>
            </div>
          </div>
          {graphErr && (
            <p style={{ margin: 0, fontSize: 11, color: '#b45309' }}>
              Teams isn't reachable ({graphErr}) — you can still record your plan in Nexus; the first use may need a one-time permission popup.
            </p>
          )}
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Skip</button>
          <button className="primary-btn" onClick={send} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} {M.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
