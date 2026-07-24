import { useState, useEffect } from 'react';
import { Sunrise, Sunset, Coffee, X, Send, Loader2, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { graphToken, postChatMessage } from '../teamsGraph';

// ── Beginning / End-of-day / Break message ────────────────────────────────────
// BOD on first punch-in, EOD on punch-out, BREAK when stepping away. The message
// posts to a Teams GROUP CHAT from the employee's OWN ACCOUNT and is recorded in
// Nexus. Each person posts to exactly ONE chat — the one an admin bound to their
// group (managed under Shifts → Presets & groups). Employees never pick from a
// list; if their group has no bound chat, the message is recorded in Nexus only.
// Prompts skip only via the "already sent" tick, so nobody silently skips and
// nobody is nagged twice.

const MODES = {
  bod: {
    title: 'Beginning of Day', Icon: Sunrise, color: '#f59e0b', tag: 'BOD',
    sub: "First punch-in today — tell the team what's on your plate.",
    msgLabel: 'Message', msgPlaceholder: 'Good morning! Starting my day…',
    tasksLabel: "Today's tasks (one per line)", tasksHead: 'Tasks',
    tasksPlaceholder: 'Finish the Lakeline report\nCall the Riverside vendor\nReview Q2 numbers',
    cta: 'Send & start the day', ackLabel: 'I already sent my login (BOD) message',
  },
  eod: {
    title: 'End of Day', Icon: Sunset, color: '#7c3aed', tag: 'EOD',
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

// "24th", "1st", "22nd", "3rd" — the 11/12/13 exceptions fall through to "th".
const ordinal = (n) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};
const fmtWorked = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} mins`;
const todayLocalKey = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function BodModal({ mode = 'bod', required = false, onSent, onSkip, onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [bound, setBound] = useState(null);          // { id, name } from the group binding
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ack, setAck] = useState(false);
  const [workedMin, setWorkedMin] = useState(0);      // EOD only — total worked today, for the Line 3 tally

  // On open: resolve the ONE chat an admin bound to this person's group, and
  // pre-fill the composer with this person's template (their last BOD/EOD post,
  // or a starter default) so they only tweak it rather than write from scratch.
  // For EOD also pull today's worked minutes so the posted message can tally
  // total hours/minutes worked — the shift may still be open (TimeClock.jsx's
  // gate shows this modal BEFORE the actual out-punch), so add the live elapsed
  // time since the last in/break-end on top of any already-closed segments.
  useEffect(() => {
    let live = true;
    (async () => {
      const [my, tpl, status] = await Promise.all([
        api.timeMyChat().catch(() => null),
        M.reasonOnly ? Promise.resolve(null) : api.timeBodTemplate(mode).catch(() => null),
        mode === 'eod' ? api.timeStatus().catch(() => null) : Promise.resolve(null),
      ]);
      if (!live) return;
      if (my?.chatId) setBound({ id: my.chatId, name: my.chatName });
      if (tpl) {
        setMessage(prev => prev || tpl.message || '');
        setTasks(prev => prev || tpl.tasks || '');
      }
      if (status) {
        const base = status.days?.[todayLocalKey()]?.workedMin || 0;
        const last = status.lastPunch;
        const stillWorking = last && (last.kind === 'in' || last.kind === 'break_end');
        const liveMin = stillWorking ? Math.max(0, (Date.now() - new Date(last.at + 'Z').getTime()) / 60000) : 0;
        setWorkedMin(Math.round(base + liveMin));
      }
      setLoading(false);
    })();
    return () => { live = false; };
  }, [mode]);

  function buildHtml() {
    if (M.reasonOnly) return `I'm on a break${message.trim() ? ` for ${esc(message.trim())}` : ''}.`;
    // Header is 3 lines: title, then the date (with ordinal day), then the time
    // — EOD's time line also tallies total hours/minutes worked today, e.g.:
    //   End of Day
    //   Fri, July 24th, 2026
    //   12:50 AM (8:30 mins)
    const now = new Date();
    const weekday = now.toLocaleDateString(undefined, { weekday: 'short' });
    const month = now.toLocaleDateString(undefined, { month: 'long' });
    const dateStr = `${weekday}, ${month} ${ordinal(now.getDate())}, ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const line3 = mode === 'eod' ? `${timeStr} (${fmtWorked(workedMin)})` : timeStr;
    const taskLines = tasks.split('\n').map(t => t.trim()).filter(Boolean);
    return `<b>${M.title}</b><br/>${dateStr}<br/>${line3}<br/>${esc(message)}`
      + (taskLines.length ? `<br/><br/><b>${M.tasksHead}</b><br/>${taskLines.map((t, i) => `${i + 1}) ${esc(t)}`).join('<br/>')}` : '');
  }

  async function send() {
    if (busy) return;
    if (!message.trim()) { toastErr(M.reasonOnly ? 'Add a short reason.' : `Write a short ${M.title.toLowerCase()} message.`); return; }
    setBusy(true);
    const targetId = bound?.id || '';
    const targetName = bound?.name || '';
    let sent = false, sendError = '';
    if (targetId) {
      try {
        const tok = await graphToken();
        if (!tok) throw new Error('Teams not connected');
        await postChatMessage(tok, targetId, buildHtml());
        sent = true;
      } catch (e) { sendError = String(e?.message || e).slice(0, 180); }
    } else sendError = 'No team chat set up for your group';
    try {
      await api.timeBodRecord({
        kind: mode, message, tasks, channel_id: targetId, channel_name: targetName,
        sent, send_error: sent ? '' : sendError, tz_offset_min: new Date().getTimezoneOffset(),
      });
    } catch { /* the Teams post is the user-visible outcome */ }
    if (sent) toastOk(`Posted to ${targetName || 'your chat'} and recorded.`);
    else if (!targetId) toastOk('Recorded in Nexus.');
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
          {/* Target chat — the single chat an admin bound to this person's group */}
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
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                No team chat set up for you yet — your message is recorded in Nexus.
                An admin can link one under Shifts → Presets &amp; groups.
              </div>
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
