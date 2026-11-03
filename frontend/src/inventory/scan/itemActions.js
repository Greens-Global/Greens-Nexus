// Items phase 4 - what a person can do with the item they just scanned.
//
// A pure reading of the screen's own data (the item, the checkouts and the
// assignments the person can already see) into the item's ONE state line
// and its primary actions, most useful first. The server still decides: an
// action shown here runs the existing Items call, which refuses what the
// person may not do (and says why) - this only keeps the buttons honest.

import { formatDate } from '../../lib/datetime';
import { checkoutDueInfo } from '../model/due';

export const LIVE_CHECKOUT = ['pending', 'approved', 'pending_receipt', 'allocated'];
const LIVE_ASSIGNMENT = ['pending_acceptance', 'active', 'return_initiated'];
const NOT_LENDABLE_OP = new Set(['lost', 'retired', 'in_repair', 'needs_replacement']);

const lower = (s) => String(s || '').trim().toLowerCase();

/** The live checkout on this item (the newest), if the person can see one. */
export function liveCheckoutFor(item, checkouts) {
  const rows = (checkouts || []).filter((c) => c.itemId === item?.id && LIVE_CHECKOUT.includes(c.status));
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return rows[0] || null;
}

/** The live assignment on this item, if the person can see one. */
export function liveAssignmentFor(item, assignments) {
  return (assignments || []).find((a) => a.itemId === item?.id && LIVE_ASSIGNMENT.includes(a.status)) || null;
}

/**
 * { state, actions: [{ key, label, primary? }], checkout, assignment }
 *
 * keys: borrow, return, confirm-receipt, hand-over, review-request,
 *       accept-assignment, return-assignment, details, print-tag
 */
export function itemActionsFor({ item, checkouts = [], assignments = [], userEmail = '', isManager = false } = {}) {
  if (!item) return { state: '', actions: [], checkout: null, assignment: null };
  const me = lower(userEmail);
  const co = liveCheckoutFor(item, checkouts);
  const asg = liveAssignmentFor(item, assignments);
  const mine = !!co && !!me && lower(co.requestedByEmail) === me;
  const handsOver = !!co && !!me && lower(co.assignedAllocatorEmail) === me;
  const myAsg = !!asg && !!me && lower(asg.assigneeEmail) === me;
  const actions = [];
  let state;
  const who = co?.requestedBy || item.activeRequestedBy || '';

  if (co) {
    if (co.status === 'allocated') {
      const { due, daysLeft } = checkoutDueInfo(co);
      const dueText = formatDate(due);
      state = mine
        ? (!dueText ? 'With you' : daysLeft < 0 ? `With you - overdue since ${dueText}` : `With you - due back ${dueText}`)
        : `With ${who || 'someone'}${dueText ? ` - due back ${dueText}` : ''}`;
      if (mine) actions.push({ key: 'return', label: 'Start Return', primary: true });
    } else if (co.status === 'pending_receipt') {
      state = mine ? 'Handed over - confirm you have it' : `Handed over to ${who || 'someone'} - waiting for them to confirm`;
      if (mine) actions.push({ key: 'confirm-receipt', label: 'Confirm Receipt', primary: true });
    } else if (co.status === 'approved') {
      state = mine ? 'Approved - waiting for the handover' : `Approved for ${who || 'someone'} - waiting for the handover`;
      // The requester never hands an item over to themselves (the server refuses it).
      if (!mine && (handsOver || isManager)) actions.push({ key: 'hand-over', label: 'Hand Over', primary: true });
    } else {
      state = mine ? 'You asked for it - waiting for approval' : `Requested by ${who || 'someone'} - waiting for approval`;
      if (!mine && isManager) actions.push({ key: 'review-request', label: 'Review Request', primary: true });
    }
  } else if (asg) {
    const holder = asg.assigneeName || item.assignedToName || 'someone';
    if (asg.status === 'pending_acceptance') {
      state = myAsg ? 'Assigned to you - waiting for you to accept' : `Assigned to ${holder} - waiting for them to accept`;
      if (myAsg) actions.push({ key: 'accept-assignment', label: 'Accept', primary: true });
    } else if (asg.status === 'active') {
      state = myAsg ? 'Assigned to you' : `Assigned to ${holder}`;
      if (myAsg) actions.push({ key: 'return-assignment', label: 'Start Return', primary: true });
    } else {
      state = myAsg ? 'You started the return' : `${holder} started the return`;
    }
  } else if (item.opStatus === 'lost') {
    state = 'Reported lost';
  } else if (item.status === 'retired' || item.opStatus === 'retired') {
    state = 'Retired';
  } else if (item.ownershipType === 'permanent') {
    state = item.assignedToName ? `Assigned to ${item.assignedToName}`
      : item.assignedToEmail ? 'Assigned' : 'Not assigned to anyone';
  } else if (item.status === 'available' && !item.hasActiveRequest && !NOT_LENDABLE_OP.has(item.opStatus)) {
    state = 'Available to borrow';
    actions.push({ key: 'borrow', label: 'Borrow', primary: true });
  } else if (item.hasActiveRequest || item.status === 'checked_out') {
    state = who ? `In use by ${who}` : 'In use';
  } else if (item.opStatus === 'in_repair') {
    state = 'In repair';
  } else {
    state = 'Not available to borrow right now';
  }

  if (isManager) {
    actions.push({ key: 'details', label: 'Details' });
    actions.push({ key: 'print-tag', label: 'Print Tag' });
  }
  return { state, actions, checkout: co, assignment: asg };
}
