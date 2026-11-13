// My Work - the rules the tile and the full list share (Neil, 11/13/2026).
// GET /me/work (backend/my_work_sources.py) is ONE list of everything that is
// the caller's to do; what is here is only how it is sliced and worded on
// screen, so the tile and the sheet can never disagree.

export const ROW_CAP = 7;
export const GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'later', label: 'Later' },
];

// A task and a ticket can share a numeric id: every row is keyed by both.
export const rowKey = (it) => `${it.kind || 'task'}:${it.id}`;

// The row's source: the server stamps it; a row from an older API is a task
// or a ticket by its kind.
export const sourceOf = (it) => it?.source || (it?.kind === 'ticket' ? 'tickets' : 'tasks');

/** The first `cap` rows across the four groups, overdue first, as sections
 *  with their counts - so a section header always says how much is really
 *  there even when the tile shows a slice. `only` keeps one source's rows
 *  (a filter chip); its counts are then what that source has in the group. */
export function pickRows(data, cap = ROW_CAP, only = 'all') {
  const counts = data?.counts || {};
  const out = [];
  let left = cap;
  for (const g of GROUPS) {
    const all = Array.isArray(data?.[g.key]) ? data[g.key] : [];
    const items = only === 'all' ? all : all.filter((it) => sourceOf(it) === only);
    const count = only === 'all' ? (counts[g.key] ?? items.length) : items.length;
    if (!count || left <= 0) continue;
    const slice = items.slice(0, left);
    left -= slice.length;
    out.push({ ...g, count, items: slice });
  }
  return out;
}

/** The filter chips: All, then one per source that has rows - none at all
 *  when everything is one kind (a chip that filters nothing is noise). */
export function chipsFor(data) {
  const sources = Array.isArray(data?.sources) ? data.sources.filter((s) => s?.count > 0) : [];
  if (sources.length < 2) return [];
  const total = data?.counts?.total ?? sources.reduce((n, s) => n + s.count, 0);
  return [{ key: 'all', label: 'All', count: total }, ...sources.map((s) => ({ key: s.key, label: s.label, count: s.count }))];
}

/** The card's line: what the number is made of. Tasks and tickets alone say
 *  so (Neil, 11/05/2026); once other work is in it, it is what waits on you. */
export function workSub(total, sources) {
  const others = (sources || []).some((s) => s?.count > 0 && s.key !== 'tasks' && s.key !== 'tickets');
  if (others) return `${total} Waiting on You`;
  return `${total} Open ${total === 1 ? 'Task or Ticket' : 'Tasks and Tickets'}`;
}

/** "Couldn't load Training and Time Sheet." - a source that failed is named,
 *  so a list that could not load never looks like an empty one. */
export function errorLine(errors) {
  const names = (errors || []).map((e) => e?.label).filter(Boolean);
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Couldn't load ${list}.`;
}
