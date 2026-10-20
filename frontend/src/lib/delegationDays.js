import { formatDate } from './datetime';

// Delegate My Approvals (Neil, Oct 20 2026): the days a delegation may cover.

// YYYY-MM-DD day arithmetic in UTC, so no zone shifts a day.
const isoDays = (a, b) => {
  const out = [];
  if (!a || !b || b < a) return out;
  const d = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  for (let n = 0; d <= end && n < 400; n += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};
const isWeekend = (iso) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w === 0 || w === 6; };

// The server's rule (approval_delegation.off_problem), so the button says
// why before the request does: every working day inside the time off, and at
// least one day of it.
export function offRangeProblem(start, end, offRanges) {
  if (!start || !end || end < start) return '';
  const covered = new Set((offRanges || []).flatMap(r => isoDays(r.start, r.end)));
  const days = isoDays(start, end);
  if (!days.some(d => covered.has(d))) return 'Pick days inside your approved time off.';
  const gap = days.find(d => !covered.has(d) && !isWeekend(d));
  return gap ? `${formatDate(gap)} is not inside your approved time off.` : '';
}
