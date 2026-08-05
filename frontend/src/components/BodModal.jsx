import { useState, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { Sunrise, Sunset, Coffee, X, Send, Loader2, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { msalInstance } from '../msalInstance';
import { formatTime } from '../lib/datetime';
import { useRole } from '../contexts/RoleContext';
import { cleanName, emailToName } from '../lib/utils';

// ── Beginning / End-of-day / Break message ────────────────────────────────────
// BOD on first punch-in, EOD on punch-out, BREAK when stepping away. The message
// posts to a Teams GROUP CHAT from the employee's OWN ACCOUNT and is recorded in
// Nexus. Each person posts to exactly ONE chat - the one an admin bound to their
// group (managed under Shifts → Presets & groups). Employees never pick from a
// list; if their group has no bound chat, the message is recorded in Nexus only.
// Prompts skip only via the "already sent" tick, so nobody silently skips and
// nobody is nagged twice.

const MODES = {
  bod: {
    title: 'Beginning of Day', Icon: Sunrise, color: '#f59e0b', tag: 'BOD',
    sub: "First punch-in today - tell the team what's on your plate.",
    msgLabel: 'Message', msgPlaceholder: 'Good morning! Starting my day…',
    tasksLabel: "Today's tasks (one per line)", tasksHead: 'Tasks',
    tasksPlaceholder: 'Finish the Lakeline report\nCall the Riverside vendor\nReview Q2 numbers',
    cta: 'Send & start the day', ackLabel: 'I already sent my login (BOD) message',
  },
  eod: {
    title: 'End of Day', Icon: Sunset, color: '#7c3aed', tag: 'EOD',
    sub: 'Wrapping up - post your summary and the tasks you worked on.',
    msgLabel: 'Summary', msgPlaceholder: 'Wrapping up - good progress today.',
    tasksLabel: 'Tasks (one per line)', tasksHead: 'Tasks (Completed)',
    tasksPlaceholder: 'Lakeline report\nRiverside vendor call\nQ2 numbers review',
    cta: 'Send & clock out', ackLabel: 'I already sent my logout (EOD) message',
  },
  break: {
    title: 'Going on break', Icon: Coffee, color: '#b45309', tag: 'BREAK', reasonOnly: true,
    sub: 'Let the team know - this posts "I\'m on a break for …" to your chat.',
    msgLabel: 'Reason', msgPlaceholder: 'Lunch',
    cta: 'Start break & notify', ackLabel: 'I already told my team',
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', display: 'block', marginBottom: 5 };

// "24th", "1st", "22nd", "3rd" - the 11/12/13 exceptions fall through to "th".
const ordinal = (n) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};
const fmtWorked = (min) => `${Math.floor(min / 60)}hrs:${String(min % 60).padStart(2, '0')}mins`;
const todayLocalKey = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function BodModal({ mode = 'bod', required = false, onSent, onSkip, onClose, toastOk, toastErr }) {
  const M = MODES[mode] || MODES.bod;
  const { accounts } = useMsal();
  const { actingAs, realEmail } = useRole();
  // Act As (Jul 2026): while impersonating, the post is still attributed to and
  // sent as the TARGET employee (see act_as.py), but the real person at the
  // keyboard must stay visible to the team - so an "on behalf of" line is
  // appended naming the real actor. accounts[0] is always the REAL signed-in
  // account (MSAL is untouched by the Act As overlay), so its name is who was
  // really acting, not the target being impersonated.
  const actingOnBehalfName = actingAs
    ? cleanName(accounts[0]?.name) || emailToName(realEmail)
    : '';
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState('');
  const [pending, setPending] = useState('');        // EOD only - starts empty; empty = no section in the post
  const [pendingSugg, setPendingSugg] = useState(''); // open Nexus tasks, offered via one-click insert
  const [bound, setBound] = useState(null);          // { id, name } from the group binding
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ack, setAck] = useState(false);
  const [workedMin, setWorkedMin] = useState(0);      // EOD only - total worked today, for the Line 3 tally

  // On open: resolve the ONE chat an admin bound to this person's group. Every
  // field starts EMPTY on purpose - pre-filling (yesterday's text, open tasks)
  // kept getting posted untouched (Jul 25). The person's open Nexus tasks are
  // fetched as a SUGGESTION they can insert with one click, never auto-posted.
  useEffect(() => {
    let live = true;
    (async () => {
      const my = await api.timeMyChat().catch(() => null);
      if (!live) return;
      if (my?.chatId) setBound({ id: my.chatId, name: my.chatName });
      setLoading(false);
    })();
    if (mode === 'eod') {
      api.getTasks().then((rows) => {
        if (!live) return;
        const email = (msalInstance.getActiveAccount()?.username || '')
          .toLowerCase().replace('@greensg.onmicrosoft.com', '@greensglobal.com');
        const open = (rows || []).filter(t => (t.assigneeId || '').toLowerCase() === email && !t.completed);
        setPendingSugg(open.slice(0, 12).map(t => t.title).filter(Boolean).join('\n'));
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [mode]);

  function buildHtml(workedMin = 0) {
    const onBehalf = actingOnBehalfName ? `<br/><i>On behalf of ${esc(actingOnBehalfName)}</i>` : '';
    if (M.reasonOnly) return `I'm on a break${message.trim() ? ` for ${esc(message.trim())}` : ''}.${onBehalf}`;
    // Three-line header (spec, Jul 24):
    //   End of Day
    //   Fri, July 24th, 2026
    //   12:50 AM (8hrs:30mins)     ← the tally is total worked today, EOD only
    const now = new Date();
    const ordinal = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
    // Locale pinned to en-US so the post reads the same for everyone regardless
    // of the sender's browser locale. Date line format: "Fri, July 24th, 2026".
    const dateStr = `${now.toLocaleDateString('en-US', { weekday: 'short' })}, ${now.toLocaleDateString('en-US', { month: 'long' })} ${ordinal(now.getDate())}, ${now.getFullYear()}`;
    const timeStr = formatTime(now);
    const tally = mode === 'eod' && workedMin > 0 ? ` (${fmtWorked(workedMin)})` : '';
    // Lists are auto-numbered "1. …" - strip any numbering people typed
    // themselves so lines don't come out as "1. 1) Task".
    const normalize = (s) => s.split('\n').map(t => t.trim().replace(/^\d+[).:]?\s*/, '')).filter(Boolean);
    const numbered = (lines) => lines.map((t, i) => `${i + 1}. ${esc(t)}`).join('<br/>');
    const taskLines = normalize(tasks);
    const pendingLines = mode === 'eod' ? normalize(pending) : [];
    return `<b>${M.title}</b><br/>${dateStr}<br/>${timeStr}${tally}${onBehalf}<br/><br/>${esc(message)}`
      + (taskLines.length ? `<br/><br/><b>${M.tasksHead}</b><br/>${numbered(taskLines)}` : '')
      + (pendingLines.length ? `<br/><br/><b>Pending Tasks</b><br/>${numbered(pendingLines)}` : '');
  }

  async function send() {
    if (busy) return;
    if (!message.trim()) { toastErr(M.reasonOnly ? 'Add a short reason.' : `Write a short ${M.title.toLowerCase()} message.`); return; }
    setBusy(true);
    // EOD tally: total minutes worked today, straight from the server's punch
    // math (same figure the Time Clock "Worked today" card shows). Best-effort -
    // a failed fetch just posts the message without the tally.
    let workedMin = 0;
    if (mode === 'eod') {
      try {
        const st = await api.timeStatus();
        const key = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        // The EOD posts BEFORE the out-punch is written, so the server summary
        // counts the still-open session as zero. Recompute today's total from
        // the raw punches, timing the open session up to "now". Sessions are
        // attributed to the local date of their in-punch (server semantics).
        const all = Object.values(st?.days || {}).flatMap(d => d.punches || [])
          .filter(p => !p.voided).sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const utc = (s) => Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
        let ms = 0, openIn = null, openInDate = '', openBreak = null, brkMs = 0;
        for (const p of all) {
          const t = utc(p.at);
          // A new 'in' always (re)opens the session - mirrors the backend's
          // _day_summaries, which does the same unconditionally and just flags
          // the abandoned one as "missing_out". Gating this on `openIn == null`
          // meant a single forgotten punch-out anywhere in the trailing 7 days
          // left `openIn`/`openInDate` stuck on that stale day forever after:
          // every later 'in' was silently ignored, so `openInDate` could never
          // match today's `key` again and the tally stayed 0 - for anyone with
          // one missed punch-out in the window, not just that one day.
          if (p.kind === 'in') { openIn = t; openInDate = p.localDate; openBreak = null; brkMs = 0; }
          else if (p.kind === 'break_start') { if (openIn != null && openBreak == null) openBreak = t; }
          else if (p.kind === 'break_end') { if (openBreak != null) { brkMs += t - openBreak; openBreak = null; } }
          else if (p.kind === 'out' && openIn != null) {
            if (openBreak != null) { brkMs += t - openBreak; openBreak = null; }
            if (openInDate === key) ms += Math.max(0, t - openIn - brkMs);
            openIn = null; brkMs = 0;
          }
        }
        if (openIn != null && openInDate === key) {
          const nowMs = Date.now();
          if (openBreak != null) brkMs += nowMs - openBreak;
          ms += Math.max(0, nowMs - openIn - brkMs);
        }
        workedMin = Math.round(ms / 60000);
      } catch { /* tally is optional */ }
    }
    const targetId = bound?.id || '';
    const targetName = bound?.name || '';
    // The browser only COMPOSES; the SERVER delivers (teams_post.py) using the
    // session's own 90-day credential and retries until it lands. No client
    // Graph call, so a stale browser token can never lose a post and nothing
    // here can ever raise a Microsoft sign-in mid-punch.
    let resp = null;
    try {
      resp = await api.timeBodRecord({
        kind: mode, message, tasks, channel_id: targetId, channel_name: targetName,
        html: targetId ? buildHtml(workedMin) : '',
        sent: false, send_error: targetId ? '' : 'No team chat set up for your group',
        tz_offset_min: new Date().getTimezoneOffset(),
      });
    } catch { /* recording failed after api.js retries - surfaced below */ }
    if (!targetId) toastOk('Recorded in Nexus.');
    else if (resp?.sent) toastOk(`Posted to ${targetName || 'your chat'} and recorded.`);
    else if (resp?.queued) toastOk(`Recorded - your ${MODES[mode]?.tag || 'Teams'} post to ${targetName || 'your chat'} is on its way.`);
    else toastErr('Could not record your message - check your connection and try again.');
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
          {mode === 'eod' && (
            <div>
              <label style={FL}>Pending tasks (one per line)</label>
              <textarea className="form-input" rows={3} value={pending} onChange={e => setPending(e.target.value)}
                placeholder="Anything still open - leave empty to skip this section"
                style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
              {pendingSugg && !pending.trim() ? (
                <button type="button" onClick={() => setPending(pendingSugg)}
                  style={{ marginTop: 4, border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                           fontSize: 11, fontWeight: 600, color: M.color, fontFamily: 'Inter,sans-serif' }}>
                  + Add my open tasks ({pendingSugg.split('\n').length})
                </button>
              ) : (
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                  Left empty, this section is left out of the post.
                </p>
              )}
            </div>
          )}
          {/* Target chat - the single chat an admin bound to this person's group */}
          <div>
            <label style={FL}>Posts to</label>
            {loading ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Finding your team chat…
              </div>
            ) : bound ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 9, background: 'var(--bg)', fontSize: 12.5, fontWeight: 700 }}>
                <MessageSquare size={13} style={{ color: 'var(--wk-brand)' }} /> {bound.name || 'Your team chat'}
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                No team chat set up for you yet - your message is recorded in Nexus.
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
