// Approvals (Oct 27 2026): what each inline action on an Approvals row calls.
// NO NEW APPROVAL PATHS - every entry is the module's EXISTING endpoint, the
// same call its own screen makes, so the server runs the same permission
// checks (backend/approvals_inbox.py names the rows; this names the calls).
//
//   APPROVAL_ACTIONS[row.kind][action.key](row, note, opts) -> Promise
//
// A row kind or action missing here is not run inline: the row offers Open
// (its module) instead. Adding a source: one entry here per action key the
// backend row offers.
import { api } from '../api';
import { formatDate } from './datetime';

// How long a decision waits before it is sent - the Undo window.
export const UNDO_MS = 5000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A task comment is HTML; the vote is its first word (hiring_decision.parse_vote).
const voteBody = (word, why) => `<p>${esc(`${word} - ${String(why || '').trim()}`).replace(/\n/g, '<br>')}</p>`;

export const APPROVAL_ACTIONS = {
  // Team > Requests / People > Time (routers/timeclock.py decide_timeoff).
  time_off: {
    approve: (r) => api.timeOffDecide(r.id, { status: 'approved', note: '' }),
    reject: (r, note) => api.timeOffDecide(r.id, { status: 'rejected', note }),
  },
  // Second Approval By HR (leave depth, Oct 27 2026): HR's own door,
  // POST /timeoff/{id}/hr-decision (hr_decide_timeoff).
  time_off_hr: {
    approve: (r) => api.timeOffHrDecide(r.id, { status: 'approved', note: '' }),
    reject: (r, note) => api.timeOffHrDecide(r.id, { status: 'rejected', note }),
  },
  // People > Time > Punch requests (decide_punch_request / decide_punch_edit).
  punch_fix: {
    approve: (r) => api.timeDecidePunchRequest(r.id, { status: 'approved', note: '' }),
    reject: (r, note) => api.timeDecidePunchRequest(r.id, { status: 'rejected', note }),
  },
  punch_edit: {
    approve: (r) => api.timePunchEditDecide(r.id, { status: 'approved', note: '' }),
    reject: (r, note) => api.timePunchEditDecide(r.id, { status: 'rejected', note }),
  },
  // Workday > Reimbursements (routers/reimbursements.py decide) - a note is
  // required to send back or reject.
  reimbursement: {
    approve: (r, note) => api.decideReimbursement(r.id, { action: 'approve', note }),
    send_back: (r, note) => api.decideReimbursement(r.id, { action: 'send_back', note }),
    reject: (r, note) => api.decideReimbursement(r.id, { action: 'reject', note }),
  },
  // Team > Requests (shift_requests.decide). `force` approves over the new
  // owner's conflict warning, after the person said so (a 409 first).
  shift_request: {
    approve: (r, note, opts = {}) => api.shiftRequestDecide(r.id, { approve: true, note, ...(opts.force ? { force: true } : {}) }),
    decline: (r, note) => api.shiftRequestDecide(r.id, { approve: false, note }),
  },
  // Workday's Shift Requests card (shift_requests.respond).
  shift_peer: {
    accept: (r) => api.shiftRequestRespond(r.id, { accept: true }),
    decline: (r, note) => api.shiftRequestRespond(r.id, { accept: false, note }),
  },
  // HR (Oct 27 2026). Salary advances: HR decides (routers/salary_advances.py
  // decide; a decline needs a note). Paying one out opens its card.
  salary_advance: {
    approve: (r) => api.decideSalaryAdvance(r.id, { action: 'approve', note: '' }),
    decline: (r, note) => api.decideSalaryAdvance(r.id, { action: 'decline', note }),
  },
  // A manager's Confirm / Extend recommendation (routers/hr_probation.py
  // approve / decline - approving sends the letter). End Employment opens
  // the profile, where the Offboard flow starts.
  probation: {
    approve: (r) => api.probationApprove(r.id, {}),
    decline: (r, note) => api.probationDecline(r.id, note),
  },
  // A goal a direct report proposed for themselves (Performance, Oct 29
  // 2026): POST /performance/goals/{id}/approve - the Approve on the goal.
  perf_goal: {
    approve: (r) => api.perfGoalApprove(r.id),
  },
  // An HR letter request: Review opens the HR Letters card; a decline needs a reason.
  hr_letter: {
    decline: (r, note) => api.hrLetterDecline(r.id, note),
  },
  // A headcount request's department or HR step (routers/hiring.py decide_headcount).
  headcount: {
    approve: (r) => api.decideHeadcount(r.id, 'approve', ''),
    decline: (r, note) => api.decideHeadcount(r.id, 'decline', note),
  },
  // India Contractor Extra Time (routers/extra_time.py decide_claim): Approve
  // takes every hour claimed; fewer hours are approved on People > Time >
  // Extra Time (Review). A decline needs a reason the contractor sees.
  extra_time: {
    approve: (r) => api.extraTimeDecide(r.id, { decision: 'approve', minutes: 0 }),
    decline: (r, note) => api.extraTimeDecide(r.id, { decision: 'decline', reason: note }),
  },
  // A "Decide on" task: the vote is a comment that starts with Yes or No and
  // says why (Neil, Oct 19) - the module's only way to vote.
  hiring_vote: {
    yes: (r, note) => api.addTaskComment(r.id, { body: voteBody('Yes', note) }),
    no: (r, note) => api.addTaskComment(r.id, { body: voteBody('No', note) }),
  },
  // ── Every other approval (Neil, 10/28/2026: "make sure all approvals go
  // into that approval box"). Rows that need more than a note (an allocator
  // to pick, a return photo, the vault's code step, a page or log to read, a
  // packet to verify) only offer Open, so they have no entry here.
  // An approval task: the task drawer's Approval block (PATCH /tasks/{id}).
  task_approval: {
    approve: (r) => api.updateTask(r.id, { approval_status: 'approved' }),
    changes: (r) => api.updateTask(r.id, { approval_status: 'changes_requested' }),
    reject: (r) => api.updateTask(r.id, { approval_status: 'rejected' }),
  },
  // A due-date ask on a task: an extension held for approval, or a new
  // date an assignee proposed (routers/tasks.py respond_due). Suggesting a
  // third date stays on the task.
  task_date_ask: {
    approve: (r, note) => api.respondTaskDue(r.id, true, note),
    decline: (r, note) => api.respondTaskDue(r.id, false, note),
  },
  // A ticket's named approver (routers/tickets.py decide_approval) - a
  // reject needs a reason.
  ticket_approval: {
    approve: (r) => api.decideTicketApproval(r.id, 'approve', ''),
    reject: (r, note) => api.decideTicketApproval(r.id, 'reject', note),
  },
  // More days on a checked-out item (items.py resolve_extension).
  item_extension: {
    approve: (r, note) => api.resolveItemExtension(r.id, { action: 'approve', note }),
    reject: (r, note) => api.resolveItemExtension(r.id, { action: 'reject', note }),
  },
  // An item assigned to me: the acceptance photo is optional (Neil, Jul 17).
  assignment_accept: {
    accept: (r) => api.acceptAssignment(r.id, {}),
    decline: (r, note) => api.declineAssignment(r.id, { note }),
  },
  // Tasks > Teams: a member request (administrators) and a personal team
  // asking to be a workspace team (Send Back leaves it personal).
  task_member_request: {
    approve: (r) => api.decideTaskMemberRequest(r.id, 'approved'),
    deny: (r) => api.decideTaskMemberRequest(r.id, 'rejected'),
  },
  task_team_approval: {
    approve: (r) => api.decideTeamApproval(r.id, 'approved'),
    send_back: (r) => api.decideTeamApproval(r.id, 'rejected'),
  },
  // A role change request from before Oct 22 (routers/hr_life_events.py).
  role_change: {
    approve: (r) => api.approveRoleChange(r.id),
    decline: (r, note) => api.declineRoleChange(r.id, note),
  },
  // A vendor or customer change (routers/accounting_partners.py).
  accounting_partner_change: {
    approve: (r) => api.decideAccountingPartnerChange(r.id, 'approve', ''),
    decline: (r, note) => api.decideAccountingPartnerChange(r.id, 'decline', note),
  },
  // A Credential Vault share request: approving goes through the vault's
  // code step (Review opens it); Deny runs here.
  credvault_request: {
    deny: (r) => api.cvDenyRequest(r.id),
  },
  // Workflows (Oct 28 2026): an Ask For Approval step names its own options
  // (Approve / Decline, or whatever the builder wrote), so EVERY action key
  // the row offers decides it - POST /workflows/approvals/{id}/decide with
  // that option. A Proxy answers any key; `open` still opens the run.
  workflow: new Proxy({}, {
    get: (_, key) => (typeof key === 'string' && key !== 'open'
      ? (r, note) => api.wfApprovalDecide(r.id, { option: key, note: note || '' })
      : undefined),
  }),
};

/** Can this action run in place (else the row opens its module)? */
export const runsInline = (row, key) => key !== 'open' && typeof APPROVAL_ACTIONS[row?.kind]?.[key] === 'function';

/** The one-click yes a row can join Approve Selected with (Neil, 10/28/2026:
 *  "easy for anyone to clear the approvals"): its primary action, run in
 *  place, asking for no note. A row without one is decided on its own. */
export const bulkAction = (row) => (row?.actions || [])
  .find((a) => a.tone === 'primary' && (!a.note || a.note === 'none') && runsInline(row, a.key)) || null;

/** Run one action; rejects with the module's own error when it refuses. */
export function runApproval(row, key, note = '', opts = {}) {
  const fn = APPROVAL_ACTIONS[row?.kind]?.[key];
  if (typeof fn !== 'function') return Promise.reject(new Error('Open it in its module to decide.'));
  return Promise.resolve().then(() => fn(row, note || '', opts));
}

// The first word of the Undo toast once a decision is queued. A workflow's
// option keys are whatever the builder wrote ("Approve", "Send Back"), so
// the lookup ignores case and spacing.
const DONE = { approve: 'Approved', reject: 'Rejected', decline: 'Declined', accept: 'Accepted',
  send_back: 'Sent back', yes: 'Voted Yes', no: 'Voted No', deny: 'Denied', changes: 'Changes requested' };
export const doneWord = (key) => DONE[String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_')] || 'Done';

/** "Priya Sharma" -> "Priya S."; a team, a place or a role stays as it is. */
export function shortName(person) {
  const name = String(person?.name || '').trim();
  if (!name) return '';
  if (name.includes('@')) return name.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const parts = name.split(/\s+/);
  if (!person?.email || parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** How long it has waited: "Just now", "45m ago", "5h ago", "3d ago"; past
 *  eight weeks, the date it came in. */
export function waited(iso, now = Date.now()) {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60e3) return 'Just now';
  const m = Math.floor(ms / 60e3);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 56) return `${d}d ago`;
  return formatDate(iso);
}
