import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api } from '../api';
import { useNotifications } from '../contexts/NotificationContext';
import { ROLES } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { useIsMobile } from '../lib/useIsMobile';
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
// Oct 17 (Neil): the bar is a HEADLINE, never the whole message - a long
// reason turned it into a wall of yellow on a phone. It shows the title and
// a one-line summary (the body's first line, else its first sentence); tap
// the text for the full message in a sheet (phone) or a popover (desktop).
// Senders put the free text on its own line ("...\nReason: ...") so the
// summary stops before it. Show All is a sheet / capped dropdown, never a
// taller bar.
//
// Same data as the bell (NotificationContext): nothing is fetched twice.

const BAR = {
  position: 'sticky', top: 0, zIndex: 60,
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', margin: '0 0 8px',
  background: '#FFF3C4', color: '#5b4300', border: '1px solid #f2d36b', borderRadius: 10, fontSize: '0.84rem',
  boxShadow: '0 2px 8px rgba(91, 67, 0, 0.12)',
};
const BTN = { border: '1px solid #d9b93a', background: '#fff8dc', color: '#5b4300', borderRadius: 8, padding: '4px 10px', font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 };
const ICON = { border: 'none', background: 'none', padding: 3, cursor: 'pointer', color: '#7a5d00', display: 'inline-flex', flexShrink: 0 };
const ONE_LINE = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const TEXT_BTN = { border: 'none', background: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'block', width: '100%' };
const PANEL = { background: '#FFFBEA', color: '#5b4300', border: '1px solid #f2d36b', boxShadow: '0 10px 30px rgba(91, 67, 0, 0.22)', fontSize: '0.86rem' };

// The bar's one line: the body's first line, and within that its first
// sentence, so "X asked to add a punch on 10/15/2026. Reason: ..." stops at
// the date even from an older sender that kept it on one line.
export function noticeSummary(body) {
  const first = String(body || '').trim().split('\n')[0].trim();
  const m = first.match(/^(.+?[.!?])\s+\S/);
  return m ? m[1] : first;
}

export default function PriorityBar({ onNavigate }) {
  const ctx = useNotifications();
  const phone = useIsMobile();
  const [at, setAt] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [detail, setDetail] = useState('');   // id of the notice whose full message is open
  const open = useMemo(() => (ctx?.notifications || []).filter((n) => n.priority === 1 && !n.closed && !n.actioned), [ctx?.notifications]);
  const barRef = useRef(null);
  const layer = showAll || !!detail;
  // Esc, or a click anywhere outside the bar (the desktop dropdown lives inside
  // it; the phone sheet has its own backdrop), puts the layer away.
  useEffect(() => {
    if (!layer) return undefined;
    const hide = () => { setDetail(''); setShowAll(false); };
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    const onDown = (e) => { if (barRef.current && !barRef.current.contains(e.target) && !e.target.closest?.('[aria-label="Priority notice details"],[aria-label="All priority notices"]')) hide(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [layer]);
  if (!ctx) return null;
  const n = open[Math.min(at, Math.max(0, open.length - 1))];
  if (!n) return null;
  const shut = () => { setDetail(''); setShowAll(false); setAt(0); };
  // Clicked off: closed for this person, kept under the bell's Closed list.
  const close = (item) => { ctx.dismiss(item.id); setDetail(''); setAt(0); if (open.length <= 2) setShowAll(false); };
  const go = (item) => {
    if (item.action?.view && onNavigate) onNavigate(item.action.view, item.action.sub);
    else if (item.action?.view) window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: item.action.view, sub: item.action.sub } }));
    // The task, ticket or timecard the notice names opens too, not just its module.
    openNotificationTarget(item.action);
    // Opened = handled: the notice leaves the bar (Neil, 10/08) and sits in
    // the bell's Closed list, where it can still be read or restored.
    ctx.markRead(item.id);
    ctx.dismiss(item.id);
    shut();
  };
  // Every open notice closed at once - each still restorable from the bell's Closed list.
  const clearAll = () => { open.forEach((item) => ctx.dismiss(item.id)); shut(); };

  const openBtn = (item) => item.action?.view && <button type="button" style={BTN} onClick={() => go(item)}>Open</button>;
  const closeBtn = (item) => (
    <button type="button" style={ICON} onClick={() => close(item)} title="Close this notice (it stays in the bell under Closed for 30 days)" aria-label="Close notice"><X size={16} /></button>
  );
  // Title + summary, one line, tap for the whole message.
  const headline = (item, { split = false } = {}) => {
    const sum = noticeSummary(item.body);
    const label = `Read the full notice: ${item.title}`;
    if (split) {
      return (
        <button type="button" style={{ ...TEXT_BTN, ...ONE_LINE }} onClick={() => setDetail(item.id)} aria-label={label}>
          <span style={{ color: '#6b5200' }}>{sum || 'Tap to read'}</span>
        </button>
      );
    }
    return (
      <button type="button" style={{ ...TEXT_BTN, ...ONE_LINE, flex: 1 }} onClick={() => setDetail(item.id)} aria-label={label}>
        <strong>{item.title}</strong>
        {sum && <span style={{ marginLeft: 8, color: '#6b5200' }}>{sum}</span>}
      </button>
    );
  };
  const pager = open.length > 1 && (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: '0.74rem', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <button type="button" style={ICON} aria-label="Previous notice" disabled={at === 0} onClick={() => setAt((a) => Math.max(0, a - 1))}><ChevronLeft size={14} /></button>
      {Math.min(at, open.length - 1) + 1} of {open.length}
      <button type="button" style={ICON} aria-label="Next notice" disabled={at >= open.length - 1} onClick={() => setAt((a) => Math.min(open.length - 1, a + 1))}><ChevronRight size={14} /></button>
    </span>
  );
  const showAllBtn = open.length > 1 && <button type="button" style={BTN} onClick={() => { setDetail(''); setShowAll(true); }}>Show All</button>;

  // The layer above the bar: a bottom sheet on a phone, a dropdown under the
  // bar on a desktop (capped, scrolling) - never a taller bar.
  const surface = (label, body) => (phone ? createPortal(
    <div role="presentation" onClick={shut} style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(15, 23, 42, 0.35)', display: 'flex', alignItems: 'flex-end' }}>
      {/* nx-sheet: already shaped for a phone - style.css's generic dialog-to-sheet rule skips it. */}
      <div role="dialog" aria-modal="true" aria-label={label} className="nx-sheet" onClick={(e) => e.stopPropagation()}
        style={{ ...PANEL, width: '100%', maxHeight: '75vh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: '14px 16px calc(16px + env(safe-area-inset-bottom))' }}>
        {body}
      </div>
    </div>, document.body)
    : (
      <div role="dialog" aria-label={label}
        style={{ ...PANEL, position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 'min(560px, 100%)', maxHeight: 340, overflowY: 'auto', borderRadius: 10, padding: '12px 14px', zIndex: 61 }}>
        {body}
      </div>
    ));
  const detailItem = detail && open.find((x) => x.id === detail);
  const detailBody = detailItem && (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <strong style={{ flex: 1, minWidth: 0 }}>{detailItem.title}</strong>
        <button type="button" style={ICON} onClick={() => setDetail('')} aria-label="Back to the bar"><X size={16} /></button>
      </div>
      {detailItem.body && <p style={{ margin: '8px 0 12px', lineHeight: 1.45, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{detailItem.body}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" style={BTN} onClick={() => close(detailItem)} title="It stays in the bell under Closed for 30 days">Close Notice</button>
        {detailItem.action?.view && <button type="button" style={{ ...BTN, background: '#5b4300', color: '#fff', borderColor: '#5b4300' }} onClick={() => go(detailItem)}>Open</button>}
      </div>
    </>
  );
  const listBody = showAll && (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ flex: 1 }}>{open.length} Priority Notices</strong>
        <button type="button" style={BTN} onClick={clearAll} title="Close every notice (they stay in the bell under Closed for 30 days)">Clear All</button>
        <button type="button" style={ICON} onClick={() => setShowAll(false)} aria-label="Hide the list"><X size={16} /></button>
      </div>
      {open.map((item) => (
        <div key={item.id} data-notice={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #f2d36b' }}>
          {headline(item)}
          {openBtn(item)}
          {closeBtn(item)}
        </div>
      ))}
    </>
  );
  const layerEl = detailItem ? surface('Priority notice details', detailBody) : (listBody ? surface('All priority notices', listBody) : null);

  if (phone) {
    // Two short rows at most: title, count and X; then the summary and Open.
    return (
      <div ref={barRef} role="alert" aria-label="Priority notice" style={{ ...BAR, display: 'block', padding: '6px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <strong style={{ ...ONE_LINE, flex: 1 }}>{n.title}</strong>
          {open.length > 1 && <button type="button" style={{ ...BTN, padding: '2px 8px' }} onClick={() => { setDetail(''); setShowAll(true); }} aria-label="Show All">{Math.min(at, open.length - 1) + 1} of {open.length}</button>}
          {closeBtn(n)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, paddingLeft: 23 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{headline(n, { split: true })}</div>
          {openBtn(n)}
        </div>
        {layerEl}
      </div>
    );
  }
  return (
    <div ref={barRef} role="alert" aria-label="Priority notice" style={BAR}>
      <AlertTriangle size={16} style={{ flexShrink: 0 }} />
      {headline(n)}
      {pager}
      {openBtn(n)}
      {!showAll && showAllBtn}
      {closeBtn(n)}
      {layerEl}
    </div>
  );
}

// A manager's priority notice: one person, a title, a line of text, and
// where Open should take them. Opened from the bell's megaphone.
const VIEWS = [
  ['', 'Nowhere - just the notice'], ['timeclock', 'Time Clock'], ['timeclock:timecard', 'Time Clock - Time Sheet'], ['timeclock:timeoff', 'Time Clock - Time Off'],
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
            <input id="pn-title" type="text" value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Sign Your Time Sheet by 5 PM Today" style={input} required />
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
