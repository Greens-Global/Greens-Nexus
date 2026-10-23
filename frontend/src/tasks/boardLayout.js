// Task Module - what a Board's columns and swimlanes are (Oct 22 2026,
// Planner's board). Pure, so the bucketing and the drop rules are testable
// without a pointer.
//
// Columns: Status (default - built-in plus custom statuses), Section (a
// project's Custom sections), Priority, or Due Date. Swimlanes (the
// toolbar's Group on Board): None, Assignee, Priority, Project, Label, or a
// select custom field - never the dimension the columns already use.
//
// Due-date buckets are the viewer's LOCAL days (lib.js todayISO / addDays),
// never toISOString(), which is the UTC day and already tomorrow on a US
// evening. Weeks run Sunday to Saturday, like the Calendar.
import { addDays, cfFieldId, cfKey } from './lib';

export const COLUMN_KINDS = ['status', 'section', 'priority', 'due'];
const COLUMN_LABELS = { status: 'Status', section: 'Section', priority: 'Priority', due: 'Due Date' };
export const PRIORITY_COLUMNS = ['urgent', 'high', 'medium', 'low'];

/** The Columns menu. Section only on a project that has Custom sections. */
export function columnOptions({ hasSections = false } = {}) {
  return COLUMN_KINDS.filter((k) => k !== 'section' || hasSections).map((k) => ({ key: k, label: COLUMN_LABELS[k] }));
}

/** A stored columns choice, or Status when it is not on offer here. */
export function effectiveColumns(value, options) {
  return (options || []).some((o) => o.key === value) ? value : 'status';
}

/** The Group menu on Board: what can be a swimlane. `fields` are the select
 *  custom fields in play; Project is left out on a project's own board, and
 *  the columns' own dimension is never offered twice. */
export function laneOptions({ columns = 'status', lockedProjectId = '', fields = [] } = {}) {
  const out = [{ key: 'none', label: 'None' }, { key: 'assignee', label: 'Assignee' }];
  if (columns !== 'priority') out.push({ key: 'priority', label: 'Priority' });
  if (!lockedProjectId) out.push({ key: 'project', label: 'Project' });
  out.push({ key: 'label', label: 'Label' });
  for (const f of fields || []) {
    if (f.type === 'select' && (f.options || []).length) out.push({ key: cfKey(f.id), label: f.name });
  }
  return out;
}

/** A stored grouping as the board's swimlanes: itself when the board offers
 *  it, else None. Nothing is written back - the stored value (and so the
 *  List's choice, or a saved view's) is left as it was. */
export function effectiveLanes(value, options) {
  return value && (options || []).some((o) => o.key === value) ? value : 'none';
}

/** The board's layout inside a project: the person's own choice there, then
 *  the project's default (when that default IS a board: its `lanes`, or -
 *  saved before boards had lanes - its `group`), then their general
 *  preference. A default's `group` stays the List's grouping. */
export function boardPrefs(mine, projectDefault, global) {
  const m = mine || {};
  const def = projectDefault?.view === 'board' ? projectDefault : {};
  const g = global || {};
  return {
    lanes: m.lanes ?? def.lanes ?? def.group ?? g.lanes ?? 'none',
    columns: m.columns ?? def.columns ?? g.columns ?? 'status',
    previews: m.previews ?? g.previews ?? true,
  };
}

/** Everything the board and its toolbar menus need, from the stored lanes
 *  and columns: the options on offer and the values in effect. */
export function boardSetup({ lanes, columns, lockedProjectId = '', fields = [], hasSections = false } = {}) {
  const columnOpts = columnOptions({ hasSections });
  const cols = effectiveColumns(columns, columnOpts);
  const laneOpts = laneOptions({ columns: cols, lockedProjectId, fields });
  return { columnOpts, columns: cols, laneOpts, lanes: effectiveLanes(lanes, laneOpts) };
}

/** Whether a board may use Section columns: one project's own Custom
 *  sections (useCustomSections), not My Tasks' personal ones. */
export const boardHasSections = (lockedProjectId, sections) =>
  !!lockedProjectId && !!sections && !sections.personal && (sections.sections || []).length > 0;

// ── Due-date columns ────────────────────────────────────────────────────────
const dayOfWeek = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // calendar parts only - no time zone
};

/** The due-date columns for `today` (a local YYYY-MM-DD), each with the day
 *  range it covers ({ from, to }, '' = open) and the day a dropped card takes
 *  (`first`). A week bucket with no days left in it (This Week on a Friday
 *  or Saturday) is left out. Overdue takes no drops; No Date clears the date. */
export function dueColumns(today) {
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6 - dayOfWeek(today));        // this Saturday
  const nextEnd = addDays(weekEnd, 7);
  const after = addDays(today, 2);
  const nextStart = addDays(weekEnd, 1) > after ? addDays(weekEnd, 1) : after;
  const cols = [
    { key: 'overdue', label: 'Overdue', from: '', to: addDays(today, -1), first: null },
    { key: 'today', label: 'Today', from: today, to: today, first: today },
    { key: 'tomorrow', label: 'Tomorrow', from: tomorrow, to: tomorrow, first: tomorrow },
    { key: 'week', label: 'This Week', from: after, to: weekEnd, first: after },
    { key: 'nextweek', label: 'Next Week', from: nextStart, to: nextEnd, first: nextStart },
    { key: 'later', label: 'Later', from: addDays(nextEnd, 1), to: '', first: addDays(nextEnd, 1) },
    { key: 'none', label: 'No Date', from: null, to: null, first: '' },
  ];
  return cols.filter((c) => c.from === '' || c.from === null || c.to === '' || c.from <= c.to);
}

/** Which due-date column `dueOn` sits in on `today`. */
export function dueColumnOf(dueOn, today) {
  const d = String(dueOn || '').slice(0, 10);
  if (!d) return 'none';
  if (d < today) return 'overdue';
  for (const c of dueColumns(today)) {
    if (c.key === 'overdue' || c.key === 'none') continue;
    if (d >= c.from && (c.to === '' || d <= c.to)) return c.key;
  }
  return 'later';
}

// ── Lane drops ──────────────────────────────────────────────────────────────
/** The labels after a card is dragged from lane `from` to lane `to` ('__none'
 *  is No Label): the label it came from is swapped for the one it landed in,
 *  and no other label is touched. Dropped on No Label it loses only the label
 *  it came from. Null when nothing changes. */
export function labelLaneTags(tags, from, to) {
  const cur = [...(tags || [])];
  const src = from && from !== '__none' ? from : null;
  const dst = to && to !== '__none' ? to : null;
  if (src === dst) return null;
  let next = src ? cur.filter((x) => x !== src) : cur;
  if (dst && !next.includes(dst)) next = [...next, dst];
  return next.length === cur.length && next.every((x, i) => x === cur[i]) ? null : next;
}

/** The assignees after a card is dragged between assignee lanes: the person
 *  whose lane it came from is swapped for the person whose lane it landed in,
 *  and anyone else on it stays. Dropped on Unassigned it means "take me off
 *  this" - only the source person goes. Null when nothing changes. */
export function assigneeLanePeople(current, from, to) {
  const cur = [...(current || [])];
  const src = from && from !== '__none' ? from : null;
  let next;
  if (to === '__none') next = src ? cur.filter((x) => x !== src) : [];
  else next = src ? cur.map((x) => (x === src ? to : x)) : [...cur, to];
  next = [...new Set(next)].filter(Boolean);
  return next.length === cur.length && next.every((x, i) => x === cur[i]) ? null : next;
}

/** A new card's fields from the lane it is added in. */
export function laneAddDefaults(lanes, laneKey) {
  if (!laneKey || laneKey === 'all' || laneKey === '__none') return {};
  if (lanes === 'assignee') return { assigneeIds: [laneKey] };
  if (lanes === 'priority') return { priority: laneKey };
  if (lanes === 'project') return { projectId: laneKey };
  if (lanes === 'label') return { tags: [laneKey] };
  const cfId = cfFieldId(lanes);
  if (cfId) return { customFieldValues: { [cfId]: laneKey } };
  return {};
}

// ── Card previews (Planner's "Show On Card") ────────────────────────────────
/** The Show On Card choices; an image is `image:<attachment id>`. */
export const SHOW_ON_CARD = [
  { key: '', label: 'Automatic' },
  { key: 'checklist', label: 'Checklist' },
  { key: 'description', label: 'Description' },
  { key: 'none', label: 'None' },
];
export const IMAGE_MODE = 'image:';

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
/** An attachment that can be a card's cover: an image file uploaded to Nexus
 *  (not an Egnyte link, not a failed upload). The server checks it again
 *  (backend task_card_preview.is_cover_file). */
export function isCoverCandidate(a) {
  if (!a || a.kind === 'egnyte') return false;
  const url = a.url || a.dataUrl || '';
  if (!url || /^data:/i.test(url)) return false;
  return a.kind === 'image' || IMAGE_NAME.test(String(a.name || '').split('?')[0]);
}
