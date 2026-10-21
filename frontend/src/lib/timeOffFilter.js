// People > Time > Time Off: status chips and column sorting (Charmi, Oct 20:
// "sort by Approved and pending ... rather than scrolling it down").
// Frontend-only - GET /timeclock/timeoff returns the whole date window at once.

// Workflow order: what still needs a decision first.
const STATUS_ORDER = { pending: 0, approved: 1, rejected: 2, cancelled: 3 };

export const TIMEOFF_FILTERS = [
  ['all', 'All'],
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['cancelled', 'Cancelled'],
];

export function countByStatus(rows) {
  const c = { all: rows.length, pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  rows.forEach(r => { if (r.status in c && r.status !== 'all') c[r.status] += 1; });
  return c;
}

const statusRank = (s) => (s in STATUS_ORDER ? STATUS_ORDER[s] : 9);
const nameOf = (r) => (r.name || r.email || '').toLowerCase();

const KEYS = {
  status: (a, b) => statusRank(a.status) - statusRank(b.status),
  period: (a, b) => (a.startDate || '').localeCompare(b.startDate || ''),
  name: (a, b) => nameOf(a).localeCompare(nameOf(b)),
};

// Stable: ties keep the server's order (newest first) via the index tiebreak.
export function filterAndSortTimeoff(rows, filter, sort) {
  const kept = filter && filter !== 'all' ? rows.filter(r => r.status === filter) : rows;
  const cmp = sort && KEYS[sort.key];
  if (!cmp) return kept;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return kept
    .map((r, i) => [r, i])
    .sort(([a, ia], [b, ib]) => (cmp(a, b) * dir) || (ia - ib))
    .map(([r]) => r);
}

// Year / Month filters (Neil, Oct 21). Dates are ISO strings, so string
// comparison is date order; a missing endDate means a one-day request.
const span = (r) => [r.startDate || r.endDate || '', r.endDate || r.startDate || ''];

// Every year any request touches, newest first.
export function yearsOf(rows) {
  const ys = new Set();
  rows.forEach(r => { const [s, e] = span(r); if (s) ys.add(s.slice(0, 4)); if (e) ys.add(e.slice(0, 4)); });
  return [...ys].sort().reverse();
}

// True when startDate..endDate overlaps the year, the month of that year, or
// (month alone) that month of any year the request touches.
export function inPeriod(r, year, month) {
  if (!year && !month) return true;
  const [s, e] = span(r);
  if (!s) return false;
  if (!year) {
    for (let y = +s.slice(0, 4); y <= +e.slice(0, 4); y++) if (inPeriod(r, String(y), month)) return true;
    return false;
  }
  const from = month ? `${year}-${month}-01` : `${year}-01-01`;
  const to = month ? `${year}-${month}-31` : `${year}-12-31`;
  return s <= to && e >= from;
}

// Click a header: a new column sorts ascending, the same column flips.
export function nextSort(sort, key) {
  if (sort?.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}
