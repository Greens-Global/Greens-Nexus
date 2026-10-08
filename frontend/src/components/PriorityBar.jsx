import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api } from '../api';
import { useNotifications } from '../contexts/NotificationContext';
import { ROLES } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { openNotificationTarget } from '../lib/openTarget';

// Priority notices (Neil, call of 09/29; adjusted 10/01): two categories of
// notification. FYI ones sit in the bell. The ones that need action (a
// timecard due, a timesheet waiting on you, a punch fix to approve) are
// this yellow bar: it sticks to the top of the person's screen until they
// act on it - Open takes them to the item AND clears the notice (Neil, 10/08:
// "once you click on open, it should remove the notification"), or they
// click it off. Either way it moves to the bell's Closed list like any other
// notification (kept 30 days, restorable), so nothing is lost. The system raises them on those flows
// (notifications with priority = 1); a manager can raise one for a person
// from the bell's megaphone. Never company-wide: each goes to one person.
//
// Same data as the bell (NotificationContext): nothing is fetched twice.

const BAR = {
  position: 'sticky', top: 0, zIndex: 60,
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', margin: '0 0 8px',
  background: '#FFF3C4', color: '#5b4300', border: '1px solid #f2d36b', borderRadius: 10, fontSize: '0.84rem',
  boxShadow: '0 2px 8px rgba(91, 67, 0, 0.12)',
};
const BTN = { border: '1px solid #d9b93a', background: '#fff8dc', color: '#5b4300', borderRadius: 8, padding: '4px 10px', font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' };
const ICON = { border: 'none', background: 'none', padding: 3, cursor: 'pointer', color: '#7a5d00', display: 'inline-flex' };

export default function PriorityBar({ onNavigate }) {
  const ctx = useNotifications();
  const [at, setAt] = useState(0);
  const open = useMemo(() => (ctx?.notifications || []).filter((n) => n.priority === 1 && !n.closed && !n.actioned), [ctx?.notifications]);
  if (!ctx) return null;
  const n = open[Math.min(at, Math.max(0, open.length - 1))];
  // Clicked off: closed for this person, kept under the bell's Closed list.
  const close = (item) => { ctx.dismiss(item.id); setAt(0); };
  const go = (item) => {
    if (item.action?.view && onNavigate) onNavigate(item.action.view, item.action.sub);
    else if (item.action?.view) window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: item.action.view, sub: item.action.sub } }));
    // The task, ticket or timecard the notice names opens too, not just its module.
    openNotificationTarget(item.action);
    // Opened = handled: the notice leaves the bar (Neil, 10/08) and sits in
    // the bell's Closed list, where it can still be read or restored.
    ctx.markRead(item.id);
    ctx.dismiss(item.id);
    setAt(0);
  };
  if (!n) return null;
  return (
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
      <button type="button" style={ICON} onClick={() => close(n)} title="Close this notice (it stays in the bell under Closed for 30 days)" aria-label="Close notice"><X size={16} /></button>
    </div>
  );
}

// A manager's priority notice: one person, a title, a line of text, and
// where Open should take them. Opened from the bell's megaphone.
const VIEWS = [
  ['', 'Nowhere - just the notice'], ['timeclock', 'Time Clock'], ['timeclock:timecard', 'Time Clock - Timecard'], ['timeclock:timeoff', 'Time Clock - Time Off'],
  ['shifts', 'Shifts'], ['tasks', 'Tasks'], ['accounting', 'Accounting'], ['hr', 'People'], ['dashboard', 'Dashboard'],
];
export function canRaiseNotice(myRole) { return (ROLES?.[myRole]?.level || 0) >= 3; }
export function RaiseNotice({ onClose, myEmail }) {
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
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>A yellow bar across the top of their screen until they click it off. Use it for things that cannot wait.</div>
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
