// The desk's work queues (Neil, 10/31/2026). Each tab on the Tickets main
// page is one of these: a filter preset over the tickets TasksContext holds,
// counted over the WHOLE workspace so a tab's number is what the desk owes,
// not what the current filters happen to show. They replaced the scope pills
// (All / My Requests / Assigned to Me) and the five summary tiles.
//
// Needs Reply is the one the server works out (`needsReply` on every row of
// GET /task-tickets, routers/tickets.py `_needs_reply`): it needs the latest
// PUBLIC comment, which the list already fetches once for everyone. The
// client fallback below is ONLY for a row that arrived without the flag (an
// older API, a fixture) and must stay identical to `_needs_reply`.
import { CLOSED_STATES, FIRST_RESPONSE_HOURS, slaPaused, slaState } from './ticketMeta';

export const QUEUES = [
  { key: 'needs_reply', label: 'Needs Reply', sort: { key: 'clock', dir: 'asc' } },
  { key: 'unassigned',  label: 'Unassigned',  tone: 'alarm' },
  { key: 'mine',        label: 'Mine' },
  { key: 'due_soon',    label: 'Due Soon',    sort: { key: 'clock', dir: 'asc' } },
  { key: 'waiting',     label: 'Waiting' },
  { key: 'open',        label: 'All Open' },
  { key: 'done',        label: 'Done' },
  { key: 'route',       label: 'To Route',    hideWhenEmpty: true, onlyDesk: true },
  { key: 'approve',     label: 'To Approve',  hideWhenEmpty: true },
  // Preventive maintenance (11/03/2026): the live tickets a schedule filed
  // (serviceId), the next clock first; the tab's count is the overdue ones when
  // there are any (counts.preventiveOverdue), in the alarm tone.
  { key: 'preventive',  label: 'Preventive',  hideWhenEmpty: true, sort: { key: 'clock', dir: 'asc' } },
  { key: 'raised',      label: 'Raised by Me' },
];

/** The local calendar day of `now`, YYYY-MM-DD - a preventive ticket's due
 *  day (pmDueOn) is a plain date. */
const dayOf = (now) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** A ticket a preventive schedule filed: its schedule AND its due day (a
 *  child of a service set from a ticket has only serviceId and stays out). */
const isPreventive = (t) => !!t.serviceId && !!t.pmDueOn;

/** A live preventive ticket whose due day has passed - the server's answer
 *  (`pmOverdue`, on the company's own calendar); the browser's date only for
 *  a row that arrived without it. */
export function preventiveOverdue(t, now = Date.now()) {
  if (!isLive(t) || !isPreventive(t)) return false;
  if (typeof t.pmOverdue === 'boolean') return t.pmOverdue;
  return t.pmDueOn < dayOf(now);
}
export const DEFAULT_QUEUE = 'needs_reply';
const WAITING_STATES = ['waiting_user', 'waiting_vendor', 'on_hold', 'waiting'];
const DEFAULT_SORT = { key: 'updated', dir: 'desc' };

const lower = (s) => (s || '').toLowerCase();
const isLive = (t) => !CLOSED_STATES.includes(t.status);
const asUtc = (iso) => (/Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
const msOf = (iso) => (iso ? new Date(asUtc(iso)).getTime() : NaN);

// The first-response clock, by the context's clock: overdue, or inside its
// own at-risk window (a quarter of the priority's target, never under an hour).
function replyClockBites(t, now) {
  if (t.firstResponseAt || !t.firstResponseDueAt) return false;
  if (t.requesterId && lower(t.requesterId) === lower(t.assigneeId)) return false;
  const left = msOf(t.firstResponseDueAt) - now;
  if (Number.isNaN(left)) return false;
  const window = Math.max(1, (FIRST_RESPONSE_HOURS[t.priority] ?? 24) / 4) * 3600 * 1000;
  return left <= window;
}

function needsReplyFallback(t) {
  if (!isLive(t) || slaPaused(t) || t.approvalStatus === 'pending') return false;
  const req = lower(t.requesterId);
  if (req && req === lower(t.assigneeId)) return false;
  if (!t.firstResponseAt) return true;
  const author = lower(t.latestComment?.authorId);
  return !!author && author === req;
}

/** Does ticket `t` belong in queue `key`? ctx = { me, onDesk, now }. */
export function queueMatches(key, t, ctx = {}) {
  const me = lower(ctx.me);
  const now = ctx.now ?? Date.now();
  switch (key) {
    case 'needs_reply':
      return typeof t.needsReply === 'boolean' ? t.needsReply : needsReplyFallback(t);
    case 'unassigned': return isLive(t) && !t.assigneeId;
    case 'mine': return isLive(t) && !!me && lower(t.assigneeId) === me;
    case 'due_soon': {
      if (!isLive(t) || slaPaused(t)) return false;
      const s = slaState(t, now);
      return s === 'breached' || s === 'at_risk' || replyClockBites(t, now);
    }
    case 'waiting': return WAITING_STATES.includes(t.status);
    case 'open': return isLive(t);
    case 'done': return !isLive(t);
    case 'route': return !!ctx.onDesk && t.approvalStatus === 'pending' && !t.approverId;
    case 'approve': return !!me && t.approvalStatus === 'pending' && lower(t.approverId) === me;
    case 'raised': return !!me && lower(t.requesterId) === me;
    case 'preventive': return isLive(t) && isPreventive(t);
    default: return false;
  }
}

/** Every queue's count over the whole list - what the tabs show. */
export function queueCounts(tickets, ctx) {
  const counts = Object.fromEntries(QUEUES.map((q) => [q.key, 0]));
  counts.preventiveOverdue = 0;
  for (const t of tickets) {
    for (const q of QUEUES) if (queueMatches(q.key, t, ctx)) counts[q.key] += 1;
    if (preventiveOverdue(t, ctx?.now ?? Date.now())) counts.preventiveOverdue += 1;
  }
  return counts;
}

/** The sort a queue opens with: urgency for Needs Reply and Due Soon, else
 *  Updated, newest first. A header click still overrides it. */
export function queueDefaultSort(key) {
  return QUEUES.find((q) => q.key === key)?.sort || DEFAULT_SORT;
}

/** A view saved before queues existed carried `filters.scope`. */
export function queueFromLegacyScope(scope) {
  return { all: 'open', mine: 'raised', assigned: 'mine', approve: 'approve', route: 'route' }[scope] || 'open';
}

/** The dashboard tile and the Tickets to Assign notice (nexus:ticket-filter). */
export function queueFromFilterEvent(f) {
  return { unassigned: 'unassigned', assigned: 'mine' }[f] || null;
}
