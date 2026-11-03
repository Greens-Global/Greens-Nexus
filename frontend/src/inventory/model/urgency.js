// Item Management - My Stuff, most urgent first (Items redesign, Neil 11/02/2026).
//
// One list of everything a person holds or is waiting on - checkouts and
// permanent assignments together - in five groups, in this order:
//   overdue   a checkout past its due date
//   today     a checkout due today
//   action    the next step is theirs: confirm a receipt, accept an
//             assignment, return an item being reassigned, or (an items
//             manager or the allocator on their own request) hand an
//             approved item to themselves
//   waiting   the next step is someone else's: approval, handover, a return
//             being checked
//   inuse     with them, nothing due today
// "Mine" is matched by email only (the name never decides it - two people
// can share one), and the email is the acting identity (useRole().myEmail),
// so Act As shows the other person's items.
import { checkoutDueInfo } from './due';

export const GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today',   label: 'Due Today' },
  { key: 'action',  label: 'Your Action Needed' },
  { key: 'waiting', label: 'Waiting on Others' },
  { key: 'inuse',   label: 'In Use' },
];
const RANK = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));

const LIVE_CO = new Set(['pending', 'approved', 'pending_receipt', 'allocated']);
const LIVE_ASG = new Set(['pending_acceptance', 'active', 'return_initiated']);
const lc = (s) => String(s || '').trim().toLowerCase();

export const isMineCheckout = (co, me) => !!me && lc(co?.requestedByEmail) === lc(me);
export const isMineAssignment = (a, me) => !!me && lc(a?.assigneeEmail) === lc(me);

/** Which group a checkout of mine belongs to (null = not live). `canSelfHandOver`:
 *  I may hand an approved request of mine to myself (items manager, or I am
 *  its allocator) - then the next step is mine, not someone else's. */
export function checkoutGroup(co, { now = new Date(), canSelfHandOver = false, me = '' } = {}) {
  if (!LIVE_CO.has(co?.status)) return null;
  if (co.status === 'allocated') {
    const { overdue, dueToday } = checkoutDueInfo(co, now);
    return overdue ? 'overdue' : dueToday ? 'today' : 'inuse';
  }
  if (co.status === 'pending_receipt') return 'action';
  if (co.status === 'approved' && (canSelfHandOver || (me && lc(co.assignedAllocatorEmail) === lc(me)))) return 'action';
  return 'waiting';
}

export function assignmentGroup(a) {
  if (!LIVE_ASG.has(a?.status)) return null;
  if (a.status === 'pending_acceptance') return 'action';
  if (a.status === 'return_initiated') {
    // A reassignment asks the holder to hand it back with a photo first.
    return a.returnReason === 'reassign' && !a.returnPhotoUrl ? 'action' : 'waiting';
  }
  return 'inuse';
}

/** [{ kind: 'checkout'|'assignment', row, group, sortKey }] sorted most
 *  urgent first; within a group the soonest due (or oldest) leads. */
export function myStuffRows(checkouts = [], assignments = [], me = '', { now = new Date(), isManager = false } = {}) {
  const out = [];
  for (const co of checkouts) {
    if (!isMineCheckout(co, me)) continue;
    const group = checkoutGroup(co, { now, canSelfHandOver: isManager, me });
    if (!group) continue;
    const { dueDay } = checkoutDueInfo(co, now);
    out.push({ kind: 'checkout', row: co, group, sortKey: dueDay || String(co.createdAt || '') });
  }
  for (const a of assignments) {
    if (!isMineAssignment(a, me)) continue;
    const group = assignmentGroup(a);
    if (!group) continue;
    // Held for good, no due date: after the dated checkouts in the same group.
    out.push({ kind: 'assignment', row: a, group, sortKey: `${group === 'inuse' ? '~' : ''}${a.createdAt || a.acceptedAt || ''}` });
  }
  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // code points: dates sort, '~' last
  return out.sort((x, y) => (RANK[x.group] - RANK[y.group]) || byKey(x.sortKey, y.sortKey));
}

/** Finished rows of mine (newest first) for the History list. */
export function myHistory(checkouts = [], assignments = [], me = '') {
  const done = [];
  for (const co of checkouts) {
    if (isMineCheckout(co, me) && !LIVE_CO.has(co.status)) done.push({ kind: 'checkout', row: co, at: co.returnedAt || co.resolvedAt || co.createdAt || '' });
  }
  for (const a of assignments) {
    if (isMineAssignment(a, me) && !LIVE_ASG.has(a.status)) done.push({ kind: 'assignment', row: a, at: a.returnAcceptedAt || a.closedAt || a.createdAt || '' });
  }
  return done.sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

/** Counts per group, for the tab badge and the group headers. */
export function groupCounts(rows) {
  const c = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  for (const r of rows) c[r.group] += 1;
  return c;
}
