// "I Need To..." (Help Center, Oct 2026): the things people come to the Help
// Center to do, each going straight to the real screen - not a ticket asking
// someone else to do it. Request Access and Report a Bug ARE tickets (that is
// the real flow for both), opened on the right type.
//
// Each door is shown only to people who can open what is behind it - the
// left menu's own rule (Sidebar's isNavItemVisible) for the module it lands
// in, and Fix My Time Sheet only for people whose time is tracked.
import { CalendarClock, Receipt, ShoppingCart, Timer, Contact, KeyRound, Bug, ChevronRight } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { NAV, isNavItemVisible } from '../components/Sidebar';

const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

// `module` = the left-menu item the screen lives in. The routes are the ones
// the Quick Actions dock uses (dashboard/widgets.jsx QUICK_ACTIONS).
const NEED_TO = [
  { key: 'time-off', label: 'Request Time Off', hint: 'Vacation, sick days and other leave', Icon: CalendarClock, module: 'myhr', run: () => go('timeclock', 'timeoff') },
  { key: 'reimbursement', label: 'Submit a Reimbursement', hint: 'Get paid back for something you bought', Icon: Receipt, module: 'myhr', run: () => go('myhr', 'reimbursements') },
  { key: 'purchase', label: 'Make a Purchase Request', hint: 'Ask for something to be bought', Icon: ShoppingCart, module: 'myhr', run: () => go('myhr', 'purchase:new') },
  { key: 'fix-time', label: 'Fix My Time Sheet', hint: 'A missed or wrong punch', Icon: Timer, module: 'myhr', timeTracked: true, run: () => go('timeclock', 'timesheet') },
  { key: 'ask-hr', label: 'Ask HR', hint: 'Pay, benefits, letters and anything private', Icon: Contact, module: 'myhr', run: () => go('myhr', 'ask-hr') },
  { key: 'access', label: 'Request Access', hint: 'An account or a permission added or changed', Icon: KeyRound, ticket: 'access_request' },
  { key: 'bug', label: 'Report a Bug', hint: 'Something in Nexus is not working', Icon: Bug, ticket: 'bug' },
];

/** The doors this person can use. */
function visibleNeeds(role) {
  return NEED_TO.filter((n) => {
    if (n.timeTracked && role?.timeTrackingExempt === true) return false;
    if (!n.module) return true;   // a ticket - anyone in the Help Center can file one
    const item = NAV.find((x) => x.view === n.module);
    return !!item && isNavItemVisible(item, role || {});
  });
}

/**
 * @param {(seed: {type: string}) => void} onTicket  open the ticket form on a type
 */
export default function NeedTo({ onTicket }) {
  const role = useRole() || {};
  const items = visibleNeeds(role);
  if (!items.length) return null;
  return (
    <section className="need-to" aria-label="I Need To" data-tour="support-need-to"
      style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '14px 16px' }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>I Need To...</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))', gap: 8 }}>
        {items.map((n) => (
          <button key={n.key} type="button" className="need-to-item"
            onClick={() => (n.ticket ? onTicket?.({ type: n.ticket }) : n.run())}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)',
              background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0,
              background: 'rgba(43,69,225,0.08)', color: 'var(--wk-brand, #2b45e1)' }}>
              <n.Icon size={16} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{n.label}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.hint}</span>
            </span>
            <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          </button>
        ))}
      </div>
    </section>
  );
}
