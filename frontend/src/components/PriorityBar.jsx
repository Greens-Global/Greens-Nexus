import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Megaphone, X } from 'lucide-react';
import { api } from '../api';
import { useNotifications } from '../contexts/NotificationContext';
import { ROLES, useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { openNotificationTarget } from '../lib/openTarget';

// Priority notices (Neil, call of 09/29): two kinds of notification - the
// quiet bell, and this bar across the top of every screen for the things
// that must be acted on (a timecard due, a timesheet waiting on you, a punch
// fix to approve). It stays until the person opens the item or marks it
// done. The system raises them on those flows (notifications with
// priority = 1); a manager can raise one for a person from the megaphone.
//
// Same data as the bell (NotificationContext): nothing is fetched twice.

const BAR = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', margin: '0 0 8px',
  background: '#FFF3C4', color: '#5b4300', border: '1px solid #f2d36b', borderRadius: 10, fontSize: '0.84rem',
};
const BTN = { border: '1px solid #d9b93a', background: '#fff8dc', color: '#5b4300', borderRadius: 8, padding: '4px 10px', font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' };
const ICON = { border: 'none', background: 'none', padding: 3, cursor: 'pointer', color: '#7a5d00', display: 'inline-flex' };

export default function PriorityBar({ onNavigate }) {
  const ctx = useNotifications();
  const { myEmail, myRole } = useRole();
  const [at, setAt] = useState(0);
  const [raising, setRaising] = useState(false);
  const open = useMemo(() => (ctx?.notifications || []).filter((n) => n.priority === 1 && !n.read && !n.actioned), [ctx?.notifications]);
  const canRaise = (ROLES[myRole]?.level || 0) >= 3;
  if (!ctx) return null;
  const n = open[Math.min(at, Math.max(0, open.length - 1))];
  const done = (item) => { ctx.markRead(item.id); setAt(0); };
  const go = (item) => {
    if (item.action?.view && onNavigate) onNavigate(item.action.view, item.action.sub);
    else if (item.action?.view) window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: item.action.view, sub: item.action.sub } }));
    // The task, ticket or timecard the notice names opens too, not just its module.
    openNotificationTarget(item.action);
    ctx.markRead(item.id);
    setAt(0);
  };
  if (!n && !canRaise) return null;
  if (!n) {
    // Nothing waiting: managers keep the megaphone to raise one.
    return raising ? <RaiseNotice onClose={() => setRaising(false)} myEmail={myEmail} /> : (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 4px' }}>
        <button type="button" onClick={() => setRaising(true)} title="Raise a priority notice for someone" aria-label="Raise a priority notice"
          style={{ ...ICON, color: 'var(--text-muted)', fontSize: '0.72rem', gap: 4, alignItems: 'center' }}>
          <Megaphone size={13} /> Priority notice
        </button>
      </div>
    );
  }
  return (
    <>
      <div role="alert" aria-label="Priority notice" style={BAR}>
        <AlertTriangle size={16} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{n.title}</strong>
          {n.body && <span style={{ marginLeft: 8, color: '#6b5200' }}>{n.body}</span>}
        </div>
        {open.length > 1 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: '0.74rem', whiteSpace: 'nowrap' }}>
            <button type="button" style={ICON} aria-label="Previous notice" disabled={at === 0} onClick={() => setAt((a) => Math.max(0, a - 1))}><ChevronLeft size={14} /></button>
            {Math.min(at, open.length - 1) + 1} of {open.length}
            <button type="button" style={ICON} aria-label="Next notice" disabled={at >= open.length - 1} onClick={() => setAt((a) => Math.min(open.length - 1, a + 1))}><ChevronRight size={14} /></button>
          </span>
        )}
        {n.action?.view && <button type="button" style={BTN} onClick={() => go(n)}>Open</button>}
        <button type="button" style={{ ...BTN, background: 'transparent' }} onClick={() => done(n)}>Done</button>
        {canRaise && <button type="button" style={ICON} onClick={() => setRaising(true)} title="Raise a priority notice for someone" aria-label="Raise a priority notice"><Megaphone size={15} /></button>}
      </div>
      {raising && <RaiseNotice onClose={() => setRaising(false)} myEmail={myEmail} />}
    </>
  );
}

// A manager's priority notice: one person, a title, a line of text, and
// where Open should take them.
const VIEWS = [
  ['', 'Nowhere - just the notice'], ['timeclock', 'Time Clock'], ['timeclock:timecard', 'Time Clock - Timecard'], ['timeclock:timeoff', 'Time Clock - Time Off'],
  ['shifts', 'Shifts'], ['tasks', 'Tasks'], ['accounting', 'Accounting'], ['hr', 'People'], ['dashboard', 'Dashboard'],
];
function RaiseNotice({ onClose, myEmail }) {
  const nameOf = useNameResolver();
  const [people, setPeople] = useState([]);
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  // The curated Nexus People list, never M365.
  useEffect(() => {
    api.getPeopleDirectory()
      .then((rows) => setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || '' })).filter((p) => p.email).sort((a, b) => a.name.localeCompare(b.name, 'en-US'))))
      .catch(() => setPeople([]));
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const send = (e) => {
    e.preventDefault();
    if (!to || !title.trim() || busy) return;
    setBusy(true);
    setError('');
    const [view, sub] = where.split(':');
    api.sendPriorityNotice({ recipient: to, title: title.trim(), body: body.trim(), requested_by: myEmail || '', action: view ? { view, sub: sub || undefined } : null })
      .then(() => { setSent(true); setTimeout(onClose, 900); })
      .catch((err) => setError(err?.message || 'Could not send the notice.'))
      .finally(() => setBusy(false));
  };
  const input = { height: 32, padding: '0 9px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.84rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' };
  const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form className="modal-content" role="dialog" aria-modal="true" aria-label="Raise a priority notice" onClick={(e) => e.stopPropagation()} onSubmit={send} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Raise a Priority Notice</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>A yellow bar across the top of their screen until they act on it. Use it for things that cannot wait.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12 }}>
          <div>
            <label style={label} htmlFor="pn-to">To</label>
            <select id="pn-to" value={to} onChange={(e) => setTo(e.target.value)} style={input} required>
              <option value="">Pick a person...</option>
              {people.map((p) => <option key={p.email} value={p.email}>{p.name || nameOf(p.email) || 'Unnamed'}</option>)}
            </select>
          </div>
          <div>
            <label style={label} htmlFor="pn-title">What must be done</label>
            <input id="pn-title" type="text" value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Sign your timecard by 5 PM today" style={input} required />
          </div>
          <div>
            <label style={label} htmlFor="pn-body">Details (optional)</label>
            <input id="pn-body" type="text" value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} placeholder="Payroll closes tonight." style={input} />
          </div>
          <div>
            <label style={label} htmlFor="pn-where">Open takes them to</label>
            <select id="pn-where" value={where} onChange={(e) => setWhere(e.target.value)} style={input}>
              {VIEWS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {error && <div style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
          {sent && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--ok-fg, #15803d)' }}>Sent.</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={!to || !title.trim() || busy}>{busy ? 'Sending...' : 'Send Notice'}</button>
        </div>
      </form>
    </div>
  );
}
