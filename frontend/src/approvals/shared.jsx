// What the desktop list (ApprovalsCenter.jsx) and the phone surface
// (ApprovalsPhone.jsx) share: the name helpers, the waiting-days math, the
// person mark, how the list is sectioned, which action keys are a "no", and
// which actions need a note before they can fire.
// Presentation helpers only - every decision still goes through
// ApprovalsCenter's `decide` and lib/approvalActions.js.
import { Users } from 'lucide-react';
import { Avatar } from '../tasks/components';
import { runsInline } from '../lib/approvalActions';

export const NO_KEYS = new Set(['reject', 'decline', 'deny', 'no']);
export const YES_KEYS = new Set(['approve', 'accept', 'yes']);

// What the note box says for each action that takes one.
export const NOTE_ASK = {
  reject: { title: 'Reject', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  decline: { title: 'Decline', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  send_back: { title: 'Send Back', message: 'Say what needs to change - they see this note.', placeholder: 'What needs to change' },
  yes: { title: 'Vote Yes', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why yes' },
  no: { title: 'Vote No', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why no' },
};

export const fullName = (person) => {
  const name = String(person?.name || '').trim();
  return name.includes('@') ? name.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : name;
};

export const daysWaiting = (r) => {
  if (!r.createdAt) return 0;
  const d = (Date.now() - new Date(r.createdAt).getTime()) / 86400e3;
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
};

export function PersonMark({ person, size }) {
  if (person?.email) return <Avatar email={person.email} name={person.name} size={size} />;
  return <span aria-hidden="true" className="apv-mark" style={{ width: size, height: size }}><Users size={Math.round(size * 0.5)} /></span>;
}

export function sectionize(rows, by, groupLabels) {
  if (by === 'none') return [{ key: 'all', label: '', rows, oldest: 0 }];
  const keyOf = by === 'department' ? (r) => r.department || 'No Department'
    : by === 'company' ? (r) => r.companyName || 'No Company'
      : by === 'person' ? (r) => fullName(r.person) || 'Your Team'
        : (r) => r.group || '';
  const labelOfKey = by === 'kind' ? (k) => groupLabels.find((g) => g.key === k)?.label || k : (k) => k;
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  // Sections keep the order the chosen sort gave their first row, so "Priority"
  // or "Newest" still reads top to bottom across sections.
  return [...m.entries()].map(([k, rs]) => ({ key: k, label: labelOfKey(k), rows: rs, oldest: Math.max(0, ...rs.map(daysWaiting)) }));
}

// The backends that refuse a no without a note (routers/reimbursements.py
// decide, hr_letters decline, salary_advances decide, shift_requests decide,
// hr_probation decline). The row's own `note: 'required'` flag from
// approvals_inbox.py says the same; this is the belt to that suspenders, so
// the phone never fires one of these without the note. Time off's reject
// stays optional (the row says `note: 'optional'`).
const NOTE_REQUIRED = {
  reimbursement: new Set(['send_back', 'reject']),
  hr_letter: new Set(['decline']),
  salary_advance: new Set(['decline']),
  shift_request: new Set(['decline']),
  probation: new Set(['decline']),
};
export const noteRequired = (row, action) => action?.note === 'required' || !!NOTE_REQUIRED[row?.kind]?.has(action?.key);
export const needsNote = (row, action) => noteRequired(row, action) || !!(action?.note && action.note !== 'none');

/** The row's actions laid out for the phone card: the yes, the no, the rest (behind Review), and the step that opens its module. */
export function layout(row) {
  const inline = (row.actions || []).filter((a) => a.key !== 'open' && runsInline(row, a.key));
  const yes = inline.find((a) => a.tone === 'primary') || inline.find((a) => YES_KEYS.has(a.key)) || null;
  const no = inline.find((a) => a !== yes && NO_KEYS.has(a.key)) || null;
  const more = inline.filter((a) => a !== yes && a !== no);
  const open = (row.actions || []).find((a) => a.key === 'open' || !runsInline(row, a.key)) || null;
  return { inline, yes, no, more, open };
}
