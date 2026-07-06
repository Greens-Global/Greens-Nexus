import { useState, useEffect } from 'react';
import { Sunrise, Sunset, Coffee, X, Send, Loader2, Link2 as LinkIcon, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { graphTokenSilent, graphTokenInteractive, graphToken, listMyChats, postChatMessage } from '../teamsGraph';

// ── Beginning / End-of-day / Break message ────────────────────────────────────
// BOD on first punch-in, EOD on punch-out, BREAK when stepping away. The message
// posts to a Teams GROUP CHAT from the employee's OWN ACCOUNT and is recorded in
// Nexus. The target chat is AUTO-RESOLVED from the employee's group binding
// (admin-managed under Shifts → Presets & groups); only if their group has no
// bound chat do they pick one manually. Prompts skip only via the "already sent"
// tick, so nobody silently skips and nobody is nagged twice.

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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

export default function BodModal({ mode = 'bod', required = false, onSent, onSkip, onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [bound, setBound] = useState(null);          // { id, name } from the group binding
  const [chats, setChats] = useState(null);          // manual picker list (null until loaded)
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ack, setAck] = useState(false);

  // On open: resolve the group-bound chat. If none, fall back to a manual picker.
  useEffect(() => {
    let live = true;
    (async () => {
      const my = await api.timeMyChat().catch(() => null);
      if (!live) return;
      if (my?.chatId) { setBound({ id: my.chatId, name: my.chatName }); setChatId(my.chatId); setLoading(false); return; }
      const tok = await graphTokenSilent();
      if (!live) return;
      if (!tok) { setNeedsConnect(true); setLoading(false); return; }
      const list = await listMyChats(tok);
      if (!live) return;
      setChats(list);
      if (list.length === 1) setChatId(list[0].id);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  async function connectTeams() {
    setConnecting(true);
    try {
      const tok = await graphTokenInteractive();
      setNeedsConnect(false);
      const list = await listMyChats(tok);
      setChats(list);
      if (list.length === 1) setChatId(list[0].id);
    } catch (e) {
      const msg = String(e?.errorMessage || e?.message || e || '');
      // Surface the real reason so consent/permission issues are diagnosable.
      const detail = /consent|AADSTS65001|admin/i.test(msg)
        ? 'Teams access needs admin approval for this app (Chat.ReadBasic, ChatMessage.Send).'
        : /popup|user_cancelled|window/i.test(msg)
        ? 'The Teams sign-in window was closed or blocked — allow pop-ups and try again.'
        : msg ? `Teams: ${msg.slice(0, 160)}` : 'Could not connect Teams.';
      toastErr(`${detail} You can still Send to record it in Nexus.`);
    } finally { setConnecting(false); }
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
    const targetId = bound?.id || chatId;
    const targetName = bound?.name || (chats || []).find(c => c.id === chatId)?.name || '';
    let sent = false, sendError = '';
    if (targetId) {
      try {
        const tok = await graphToken();
        if (!tok) throw new Error('Teams not connected');
        await postChatMessage(tok, targetId, buildHtml());
        sent = true;
      } catch (e) { sendError = String(e?.message || e).slice(0, 180); }
    } else sendError = 'No chat selected';
    try {
      await api.timeBodRecord({
        kind: mode, message, tasks, channel_id: targetId, channel_name: targetName,
        sent, send_error: sent ? '' : sendError, tz_offset_min: new Date().getTimezoneOffset(),
      });
    } catch { /* the Teams post is the user-visible outcome */ }
    if (sent) toastOk(`Posted to ${targetName || 'your chat'} and recorded.`);
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
            <textarea className="form-input" rows={2} value={message} onChange={e => setMessage(e.target.value)}
              placeholder={M.msgPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          </div>
          {!M.reasonOnly && (
            <div>
              <label style={FL}>{M.tasksLabel}</label>
              <textarea className="form-input" rows={4} value={tasks} onChange={e => setTasks(e.target.value)}
                placeholder={M.tasksPlaceholder} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
            </div>
          )}
          {/* Target chat — auto from the group binding, else a manual picker */}
          <div>
            <label style={FL}>Posts to</label>
            {loading ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Finding your team chat…
              </div>
            ) : bound ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 9, background: 'var(--bg)', fontSize: 12.5, fontWeight: 700 }}>
                <MessageSquare size={13} style={{ color: 'var(--pine)' }} /> {bound.name || 'Your team chat'}
              </div>
            ) : needsConnect ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="secondary-btn" onClick={connectTeams} disabled={connecting}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  {connecting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <LinkIcon size={13} />}
                  Connect Teams
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>one-time — or just Send to record it in Nexus.</span>
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
            title={required && !ack ? 'Tick the box if you already sent it' : ''}>Skip</button>
          <button className="primary-btn" onClick={send} disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} {M.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
