// The three registers' facts (Neil, 11/03/2026): how long an RFI or a
// submittal has been out, and whether a row is overdue - from its own dates
// against the jobsite's today (the server's `project.today`). Pure, so the
// list, the sheet and the tests read one rule.

export function dayDiff(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const OPEN = {
  rfis: (r) => (r.status || 'open') === 'open',
  submittals: (r) => ['pending', 'submitted'].includes(r.status || 'pending'),
  milestones: (r) => ['upcoming', 'at_risk'].includes(r.status || 'upcoming'),
};

const DUE = { rfis: 'dueOn', submittals: 'dueOn', milestones: 'targetDate' };

export function isOverdue(kind, row, todayISO) {
  const due = row?.[DUE[kind]];
  return !!(due && todayISO && OPEN[kind]?.(row) && String(due).slice(0, 10) < todayISO);
}

// Days an RFI or submittal has been out: from when it went out to when it
// came back - or to today while it is still open. null for a milestone or a
// row with no start.
export function daysOpen(kind, row, todayISO) {
  if (kind === 'milestones') return null;
  const start = row.submittedOn || String(row.createdAt || '').slice(0, 10);
  if (!start) return null;
  const end = OPEN[kind](row) ? todayISO : (kind === 'rfis' ? row.answeredOn : row.returnedOn) || todayISO;
  const d = dayDiff(start, end);
  return d == null || d < 0 ? null : d;
}

export function browserTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
