import { setPendingOpen } from './pendingOpen';

// Who is looking (RoleContext sets it, Act As included - the same `myEmail`
// every "mine" derivation keys on). Read only to send a link to my OWN
// card in People > Time to my own Time Sheet.
let viewerEmail = '';
export function setOpenTargetViewer(email) { viewerEmail = (email || '').trim().toLowerCase(); }

// A notification's action names WHAT it is about beside where to go: a task
// (taskId), a ticket (ticketId), or a person's timecard (timecard + start +
// payType, from timesheet_review._notify). Every place that acts on a
// notification - the bell, a toast, the priority bar - hands that target
// over the same way: the pending note for a module still downloading its
// chunk, and the live event for one already on screen (lib/pendingOpen.js).
// Without this, Valinda's timesheet notice landed on People > Time with the
// first employee selected (Visesh, 09/30).
export function openNotificationTarget(action) {
  if (!action) return;
  const fire = (name, detail) => setTimeout(() => window.dispatchEvent(new CustomEvent(name, { detail })), 0);
  if (action.taskId) { setPendingOpen('task', action.taskId); fire('nexus:open-task', { taskId: action.taskId }); }
  if (action.ticketId) { setPendingOpen('ticket', action.ticketId); fire('nexus:open-ticket', { ticketId: action.ticketId }); }
  // Tickets to Assign (Oct 26 2026): the desk opens on its Unassigned list.
  if (action.ticketFilter) { setPendingOpen('ticketFilter', action.ticketFilter); fire('nexus:ticket-filter', { filter: action.ticketFilter }); }
  // An Ask My Accountant question (Priyanka, 10/15): Accounting > AMA opens
  // with that question's panel (AskAccountantTab drains the note on mount).
  if (action.amaThreadId) { setPendingOpen('amaThread', action.amaThreadId); fire('nexus:open-ama-thread', { id: action.amaThreadId }); }
  // A punch-fix request names its row: People > Time > Punch requests, with
  // that request highlighted (Neil, 10/02). It wins over the timecard keys
  // the same action carries for older clients.
  if (action.punchRequestId) {
    setPendingOpen('punchRequest', action.punchRequestId);
    fire('nexus:open-punch-request', { id: action.punchRequestId });
    return;
  }
  // A link to MY OWN card in People > Time - a workflow notice (one link
  // for everyone on the salary_advance entity) or a bell stored before
  // its recipient got their own link - lands on my own Time Sheet (Oct 29
  // 2026 review). Dispatched now, not after a tick: the caller's own
  // navigate to People > Time came first in the same handler, so the two
  // batch and People > Time never draws.
  if (action.timecard && viewerEmail && String(action.timecard).trim().toLowerCase() === viewerEmail) {
    if (action.start) {
      const own = { start: action.start, payType: action.payType || '' };
      setPendingOpen('myTimecard', own);
      fire('nexus:open-my-timecard', own);
    }
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock', sub: 'timesheet' } }));
    return;
  }
  if (action.timecard) {
    const detail = { email: action.timecard, start: action.start || '', payType: action.payType || '' };
    setPendingOpen('timecard', detail);
    fire('nexus:open-timecard', detail);
  }
  // The employee's OWN Time Sheet on the notice's period (Oct 22): a bonus or
  // a change on a past period opened the current one, where it is not.
  if (action.view === 'timeclock' && action.start && !action.timecard) {
    const detail = { start: action.start, payType: action.payType || '' };
    setPendingOpen('myTimecard', detail);
    fire('nexus:open-my-timecard', detail);
  }
}
