// The Shift Planner's requests line (Neil, 11/04/2026: Team > Requests moved
// into Approvals - "I also like the idea of the strip as needed, as long as
// it's not messy and complicated"). One quiet line above the grid, ONLY when
// a request touches the dates on screen: how many, how many need you, and
// each one named - a request you decide opens its row in Approvals
// (approvals/focus.js), one waiting on someone else (a teammate, HR, another
// approver) is words only. Words and a hairline, no chips. Data: the
// manager inbox the Shifts module already polls (useManagerInbox) - no read
// per week.
import { Inbox } from 'lucide-react';
import { useRole } from '../../contexts/RoleContext';
import { formatDate } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import { openApproval } from '../../approvals/focus';
import { useManagerInbox } from './useManagerInbox';

const KIND = { swap: 'Swap', offer: 'Offer', open: 'Open Shift', release: 'Release' };
const SHOW = 4;
const span = (a, b) => (!b || b === a ? formatDate(a) : `${formatDate(a)} - ${formatDate(b)}`);
const LINK = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 700, color: 'var(--wk-brand)' };

// The requests that touch [start, end]: [{ key, group, who, what, wait }],
// needs-you first, then soonest. `wait` = '' when it is yours to decide.
export function requestsInRange(inbox, timeoff, start, end) {
  const out = [];
  const inRange = (a, b) => !!a && a <= end && (b || a) >= start;
  (timeoff || []).forEach((t) => {
    if (!inRange(t.startDate, t.endDate)) return;
    const mine = t.canDecide !== false && !t.awaitingHr;
    out.push({ key: `time_off:${t.id}`, group: 'timeoff', email: t.email, name: t.name, what: `Time Off ${span(t.startDate, t.endDate)}`, at: t.startDate,
      wait: mine ? '' : t.awaitingHr ? 'Waiting On HR' : `Waiting On ${t.reviewer || 'Their Manager'}` });
  });
  const dayOf = (r) => r.shift?.date || r.asked?.date || '';
  (inbox?.pending || []).forEach((r) => {
    if (!inRange(dayOf(r), dayOf(r))) return;
    out.push({ key: `shift_request:${r.id}`, group: 'shifts', email: r.requester?.email, name: r.requester?.name, what: `${KIND[r.kind] || 'Request'} ${formatDate(dayOf(r))}`, at: dayOf(r), wait: '' });
  });
  (inbox?.waitingOnPeer || []).forEach((r) => {
    if (!inRange(dayOf(r), dayOf(r))) return;
    out.push({ key: `shift_peer:${r.id}`, group: 'shifts', email: r.requester?.email, name: r.requester?.name, what: `${KIND[r.kind] || 'Request'} ${formatDate(dayOf(r))}`, at: dayOf(r), wait: 'Waiting On Teammate' });
  });
  return out.sort((a, b) => (!!a.wait - !!b.wait) || String(a.at).localeCompare(String(b.at)));
}

export default function RequestsStrip({ start, end }) {
  const { can } = useRole() || {};
  const manager = typeof can === 'function' && can('manager');
  const { inbox, timeoff } = useManagerInbox(manager);
  const nameOf = useNameResolver();
  if (!manager || !start || !end) return null;
  const items = requestsInRange(inbox, timeoff, start, end);
  if (!items.length) return null;
  const need = items.filter((i) => !i.wait).length;
  const shown = items.slice(0, SHOW);
  return (
    <div data-requests-strip="" role="note" aria-label="Requests on these dates"
      style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 13, color: 'var(--muted)', padding: '6px 2px', marginBottom: 8, borderBottom: '1px solid var(--wk-line)', fontFamily: 'Inter,sans-serif' }}>
      <Inbox size={13} aria-hidden="true" style={{ alignSelf: 'center', flexShrink: 0 }} />
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>
        {items.length === 1 ? '1 request touches these dates' : `${items.length} requests touch these dates`}{need ? ` - ${need} need${need === 1 ? 's' : ''} you` : ''}:
      </span>
      {shown.map((i, n) => {
        const label = `${nameOf(i.email, i.name)} - ${i.what}`;
        return (
          <span key={i.key} data-request={i.key}>
            {i.wait ? <span>{label} ({i.wait})</span>
              : <button type="button" style={LINK} onClick={() => openApproval(i.key, i.group)} title="Decide it in Approvals">{label}</button>}
            {n < shown.length - 1 ? ' ·' : ''}
          </span>
        );
      })}
      {items.length > SHOW && <button type="button" style={LINK} onClick={() => openApproval('', 'shifts')}>and {items.length - SHOW} more</button>}
    </div>
  );
}
