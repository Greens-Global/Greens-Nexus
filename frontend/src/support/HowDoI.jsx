// "How Do I..." (Help Center, Neil, 11/02/2026): the short answers to the
// things people come to the Help Center to do, each with the one button that
// does it - straight to the real screen, never a ticket asking someone else
// to do it. Ask HR, Request Access and Report a Bug were taken out (Neil,
// 11/04/2026): Submit a Ticket and Ask HR already sit one tile away.
//
// A TILE in the row (Neil, 11/04/2026: "condense and redesign this ... where
// it fits into a tile here"): the fifth card beside Submit a Ticket, Ask
// Nexus, Documentation and Knowledge Base & Training, filling the space the
// full-width strip left empty at the end of that row. The tile lists the
// questions as compact rows; a row opens its answer IN the tile (the list
// steps aside, Back or Escape brings it back and focus returns to the row),
// so the tile keeps its place and nothing below it moves: the list stays
// mounted (hidden and inert) and sets the tile's height, and the answer is
// laid over it, scrolling inside if it is longer.
//
// Each question is shown only to people who can open what is behind it -
// the left menu's own rule (Sidebar's isNavItemVisible) for the module it
// lands in, and the Time Sheet one only for people whose time is tracked.
import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Receipt, ShoppingCart, Timer, ChevronRight, ChevronLeft, CircleHelp } from 'lucide-react';
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
    answer: 'Open your Time Sheet, find the day and use Edit on that row to ask for the right in, out or break time with a note. Your manager approves it and the day updates when they do.',
    action: 'Open My Time Sheet', run: () => go('timeclock', 'timesheet') },
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
  const backRef = useRef(null);
  const rowRefs = useRef({});
  const last = useRef('');
  // Opening an answer moves focus to its Back; closing returns it to the row.
  useEffect(() => {
    if (open) { backRef.current?.focus(); last.current = open; return; }
    if (last.current) { rowRefs.current[last.current]?.focus(); last.current = ''; }
  }, [open]);
  if (!items.length) return null;
  const act = (n) => (n.ticket ? onTicket?.({ type: n.ticket }) : n.run());
  const cur = items.find((n) => n.key === open) || null;
  return (
    <section className={`support-card how-do-i${cur ? ' is-answer' : ''}`} aria-label="How Do I" data-tour="support-how-do-i"
      onKeyDown={(e) => { if (e.key === 'Escape' && cur) { e.stopPropagation(); setOpen(''); } }}>
      <div className="how-do-i-stack">
        <div className={`how-do-i-view${cur ? ' is-hidden' : ''}`} aria-hidden={cur ? true : undefined} inert={!!cur}>
          <div className="how-do-i-head">
            <div className="support-icon"><CircleHelp size={18} /></div>
            <div className="support-card-title">How Do I...</div>
          </div>
          <ul className="how-do-i-list">
            {items.map((n) => (
              <li key={n.key} className="how-do-i-row">
                <button type="button" className="how-do-i-q" aria-expanded={open === n.key}
                  ref={(el) => { rowRefs.current[n.key] = el; }} onClick={() => setOpen(n.key)}>
                  <span className="how-do-i-ico"><n.Icon size={15} /></span>
                  <span className="how-do-i-label">{n.q}</span>
                  <ChevronRight size={15} className="how-do-i-chev" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        {cur && (
          <div className="how-do-i-view how-do-i-answer-view" key={cur.key} role="region" aria-label={`${cur.q} answer`}>
            <div className="how-do-i-answer-head">
              <button type="button" ref={backRef} className="how-do-i-back" onClick={() => setOpen('')} aria-label="Back to How Do I">
                <ChevronLeft size={16} />
              </button>
              <span className="how-do-i-ico"><cur.Icon size={15} /></span>
              <span className="how-do-i-answer-title">{cur.q}</span>
            </div>
            <p className="how-do-i-answer">{cur.answer}</p>
            <button type="button" className="how-do-i-act" onClick={() => act(cur)}>{cur.action}<ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </section>
  );
}
