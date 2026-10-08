import { setPendingOpen } from './pendingOpen';

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
  // A punch-fix request names its row: People > Time > Punch requests, with
  // that request highlighted (Neil, 10/02). It wins over the timecard keys
  // the same action carries for older clients.
  if (action.punchRequestId) {
    setPendingOpen('punchRequest', action.punchRequestId);
    fire('nexus:open-punch-request', { id: action.punchRequestId });
    return;
  }
  if (action.timecard) {
    const detail = { email: action.timecard, start: action.start || '', payType: action.payType || '' };
    setPendingOpen('timecard', detail);
    fire('nexus:open-timecard', detail);
  }
}
