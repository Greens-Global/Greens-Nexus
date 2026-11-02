// "How Do I..." (Help Center, Neil, 11/02/2026): the short answers to the
// things people come to the Help Center to do. Replaced the "I Need To..."
// strip of seven small cards ("the UI looks shitty with so many sections")
// with ONE tile that sits in the Help Center grid beside Submit a Ticket, Ask
// Nexus, Documentation and Knowledge Base & Training, spanning the full
// width: a question per row, a dropdown with a two or three sentence answer
// and the one button that does it - straight to the real screen, never a
// ticket asking someone else to do it. Request Access and Report a Bug ARE
// tickets (that is the real flow for both), opened on the right type.
//
// Each question is shown only to people who can open what is behind it -
// the left menu's own rule (Sidebar's isNavItemVisible) for the module it
// lands in, and the Time Sheet one only for people whose time is tracked.
// One row open at a time; the open row's answer slides down (grid-rows,
// --dur-md / --ease-out, nothing under reduced motion).
import { useState } from 'react';
import { CalendarClock, Receipt, ShoppingCart, Timer, Contact, KeyRound, Bug, ChevronDown, CircleHelp } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { NAV, isNavItemVisible } from '../components/Sidebar';

const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

// `module` = the left-menu item the screen lives in. The routes are the ones
// the Quick Actions dock uses (dashboard/widgets.jsx QUICK_ACTIONS). `q` is
// the row (Title Case, it reads under the "How Do I..." title), `answer` the
// dropdown (sentence case, what happens and who sees it), `action` the button.
export const HOW_DO_I = [
  { key: 'time-off', q: 'Request Time Off', Icon: CalendarClock, module: 'myhr',
    answer: 'Open Workday > Time Off, pick the type (vacation, sick or personal), the dates and a note, and send it. Your balance shows what is left before you ask. Your manager gets it in Approvals and you get a bell when it is decided.',
    action: 'Go to Time Off', run: () => go('timeclock', 'timeoff') },
  { key: 'reimbursement', q: 'Submit a Reimbursement', Icon: Receipt, module: 'myhr',
    answer: 'Open Workday > Reimbursements, add what you bought, the amount and a photo of the receipt (Ctrl+V pastes one), and submit. It goes to your approver and then to accounting for payment, and the request shows each step.',
    action: 'Open Reimbursements', run: () => go('myhr', 'reimbursements') },
  { key: 'purchase', q: 'Make a Purchase Request', Icon: ShoppingCart, module: 'myhr',
    answer: 'Open Workday > Purchase Requests > New Purchase Request and say what is needed, why, the estimated cost and a link if you have one. Your manager approves it and accounting orders it; the request shows where it is.',
    action: 'New Purchase Request', run: () => go('myhr', 'purchase:new') },
  { key: 'fix-time', q: 'Fix My Time Sheet', Icon: Timer, module: 'myhr', timeTracked: true,
    answer: 'Open your Time Sheet, find the day and tap the punch that is missing or wrong to send a fix request with the right time and a note. Your manager approves the change and the day updates when they do.',
    action: 'Open My Time Sheet', run: () => go('timeclock', 'timesheet') },
  { key: 'ask-hr', q: 'Ask HR Something Private', Icon: Contact, module: 'myhr',
    answer: 'Ask HR is private: only the HR contact for your company sees it. Use it for pay, benefits, letters, documents and anything personal. You get a bell when HR answers, and the thread stays between you and HR.',
    action: 'Open Ask HR', run: () => go('myhr', 'ask-hr') },
  { key: 'access', q: 'Request Access to Something', Icon: KeyRound, ticket: 'access_request',
    answer: 'File an Access Request ticket with the module or system you need and why. IT and the owner of that module approve it, and you are told on the ticket when it is in place.',
    action: 'File an Access Request' },
  { key: 'bug', q: 'Report a Bug', Icon: Bug, ticket: 'bug',
    answer: 'File a Bug Report ticket: what you were doing, what happened and a screenshot if you have one (Ctrl+V pastes it). The team replies on the ticket and you get a bell on every update.',
    action: 'File a Bug Report' },
];

/** The questions this person can act on. */
export function visibleQuestions(role) {
  return HOW_DO_I.filter((n) => {
    if (n.timeTracked && role?.timeTrackingExempt === true) return false;
    if (!n.module) return true;   // a ticket - anyone in the Help Center can file one
    const item = NAV.find((x) => x.view === n.module);
    return !!item && isNavItemVisible(item, role || {});
  });
}

/**
 * @param {(seed: {type: string}) => void} onTicket  open the ticket form on a type
 */
export default function HowDoI({ onTicket }) {
  const role = useRole() || {};
  const items = visibleQuestions(role);
  const [open, setOpen] = useState('');
  if (!items.length) return null;
  const act = (n) => (n.ticket ? onTicket?.({ type: n.ticket }) : n.run());
  return (
    <section className="support-card how-do-i" aria-label="How Do I" data-tour="support-how-do-i">
      <div className="how-do-i-head">
        <div className="support-icon"><CircleHelp size={20} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="support-card-title" style={{ marginBottom: 2 }}>How Do I...</div>
          <p className="support-card-desc" style={{ margin: 0 }}>Short answers to the things people come here to do, each with the button that does it.</p>
        </div>
      </div>
      <ul className="how-do-i-list">
        {items.map((n) => {
          const isOpen = open === n.key;
          const panelId = `how-do-i-${n.key}`;
          return (
            <li key={n.key} className={`how-do-i-row${isOpen ? ' is-open' : ''}`}>
              <button type="button" className="how-do-i-q" aria-expanded={isOpen} aria-controls={panelId}
                onClick={() => setOpen(isOpen ? '' : n.key)}>
                <span className="how-do-i-ico"><n.Icon size={16} /></span>
                <span className="how-do-i-label">{n.q}</span>
                <ChevronDown size={16} className="how-do-i-chev" aria-hidden="true" />
              </button>
              <div id={panelId} className="how-do-i-panel" role="region" aria-label={`${n.q} answer`}
                aria-hidden={!isOpen} inert={isOpen ? undefined : ''}>
                <div className="how-do-i-panel-in">
                  <p className="how-do-i-answer">{n.answer}</p>
                  <button type="button" className="how-do-i-act" onClick={() => act(n)}>{n.action}</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
