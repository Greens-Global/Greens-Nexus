// Item Management - One set of words (Items redesign, Neil 11/02/2026).
//
// Every state on every Items screen reads through here and draws with
// components/StatusLabel.jsx - Title Case, American "Canceled".
//   Checkouts    Requested -> Approved -> Handed Over -> In Use -> Returned
//                (Overdue REPLACES In Use, it never sits beside it)
//   Assignments  Awaiting Acceptance -> Active -> Return Started -> Closed
// Color follows the Live accent rule (DESIGN.md): orange only for what is
// moving right now, green for done or settled, red only for overdue, slate
// for everything waiting or finished without a result.
import { checkoutDueInfo } from './due';

export const TONE = {
  slate: '#64748b',
  live: 'var(--wk-live)',
  done: 'var(--wk-green)',
  overdue: 'var(--wk-red)',
};

const CHECKOUT = {
  pending:         { label: 'Requested',   tone: 'slate' },
  approved:        { label: 'Approved',    tone: 'slate' },
  pending_receipt: { label: 'Handed Over', tone: 'live' },
  allocated:       { label: 'In Use',      tone: 'live' },
  returned:        { label: 'Returned',    tone: 'done' },
  rejected:        { label: 'Rejected',    tone: 'slate' },
  cancelled:       { label: 'Canceled',    tone: 'slate' },
};

const ASSIGNMENT = {
  pending_acceptance: { label: 'Awaiting Acceptance', tone: 'slate' },
  active:             { label: 'Active',              tone: 'done' },
  return_initiated:   { label: 'Return Started',      tone: 'live' },
  closed:             { label: 'Closed',              tone: 'slate' },
  declined:           { label: 'Declined',            tone: 'slate' },
  cancelled:          { label: 'Canceled',            tone: 'slate' },
};

const word = (m) => ({ ...m, color: TONE[m.tone] });

/** { label, tone, color } for a checkout (Overdue replaces In Use). */
export function checkoutWord(co, now = new Date()) {
  if (co?.status === 'allocated' && checkoutDueInfo(co, now).overdue) return word({ label: 'Overdue', tone: 'overdue' });
  return word(CHECKOUT[co?.status] || { label: titleCase(co?.status || 'Unknown'), tone: 'slate' });
}

/** { label, tone, color } for a permanent assignment. */
export function assignmentWord(a) {
  return word(ASSIGNMENT[a?.status] || { label: titleCase(a?.status || 'Unknown'), tone: 'slate' });
}

/** The item's own state, for the Inventory table and the record. */
export function itemWord(item, { overdue = false, requested = false } = {}) {
  if (!item) return word({ label: 'Unknown', tone: 'slate' });
  if (item.opStatus === 'lost') return word({ label: 'Lost', tone: 'slate' });
  if (item.status === 'retired' || item.opStatus === 'retired') return word({ label: 'Retired', tone: 'slate' });
  if (item.status === 'checked_out') return overdue ? word({ label: 'Overdue', tone: 'overdue' }) : word({ label: 'In Use', tone: 'live' });
  if (item.status === 'permanently_assigned') return word({ label: 'Assigned', tone: 'done' });
  if (item.opStatus === 'in_repair') return word({ label: 'In Repair', tone: 'slate' });
  if (requested || item.hasActiveRequest) return word({ label: 'Requested', tone: 'slate' });
  if (item.ownershipType === 'permanent') {
    return (!item.assignedToEmail && item.location)
      ? word({ label: 'At Location', tone: 'slate' })
      : word({ label: 'Unassigned', tone: 'slate' });
  }
  return word({ label: 'Available', tone: 'done' });
}

export function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
