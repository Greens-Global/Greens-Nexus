// Task Module — pure helpers (ported from nexus/lib/filters.ts + stats.ts).
// Operates on the runtime task shape (email used as person id).
import { PRIORITY_ORDER, STATUS_ORDER, STATUS_META } from './theme';

export const EMPTY_FILTER = {
  assigneeIds: [], statuses: [], priorities: [], departmentIds: [], projectIds: [],
  tags: [], due: 'any', dueFrom: null, dueTo: null, search: '',
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function dueMatches(task, due, dueFrom, dueTo) {
  if (dueFrom && (!task.dueOn || task.dueOn < dueFrom)) return false;
  if (dueTo && (!task.dueOn || task.dueOn > dueTo)) return false;
  if (due === 'any') return true;
  const t = todayISO();
  if (due === 'none') return !task.dueOn;
  if (!task.dueOn) return false;
  if (due === 'overdue') return task.dueOn < t && !task.completed;
  if (due === 'today') return task.dueOn === t;
  if (due === 'week') {
    const wk = new Date(); wk.setDate(wk.getDate() + 7);
    return task.dueOn >= t && task.dueOn <= wk.toISOString().slice(0, 10);
  }
  return true;
}

export function matchesFilter(task, f = EMPTY_FILTER) {
  if (f.assigneeIds?.length && !f.assigneeIds.includes(task.assigneeId)) return false;
  if (f.statuses?.length && !f.statuses.includes(task.status)) return false;
  if (f.priorities?.length && !f.priorities.includes(task.priority)) return false;
  if (f.departmentIds?.length && !f.departmentIds.includes(task.departmentId)) return false;
  if (f.projectIds?.length && !f.projectIds.includes(task.projectId)) return false;
  if (f.tags?.length && !f.tags.some((t) => (task.tags || []).includes(t))) return false;
  if (!dueMatches(task, f.due || 'any', f.dueFrom, f.dueTo)) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [task.title, task.code, task.description, ...(task.tags || [])].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export const isSection = (t) => t.type === 'section';
export const isSubtask = (t) => !!t.parentTaskId;

/** Top-level, non-section tasks. Accepts a list or an id→task map. */
export function topLevel(tasks) {
  const list = Array.isArray(tasks) ? tasks : Object.values(tasks || {});
  return list.filter((t) => !isSubtask(t) && !isSection(t));
}

const SORTERS = {
  manual: () => 0,
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  dueOn: (a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999'),
  priority: (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  assignee: (a, b) => (a.assigneeId || '').localeCompare(b.assigneeId || ''),
};

export function sortTasks(list, sort = { key: 'manual', dir: 'asc' }) {
  const fn = SORTERS[sort.key] || SORTERS.manual;
  const out = [...list].sort(fn);
  return sort.dir === 'desc' ? out.reverse() : out;
}

/** Group tasks by a GroupBy key. Returns [{ key, label, tasks }] ordered sensibly. */
export function groupTasks(list, group, ctx = {}) {
  if (!group || group === 'none') return [{ key: 'all', label: '', tasks: list }];
  // Date grouping → the export's four semantic buckets, always all shown.
  if (group === 'date') {
    const today = todayISO();
    const weekEnd = addDays(today, 7);
    const out = [
      { key: 'recent', label: 'Recently assigned', tasks: [] },
      { key: 'today', label: 'Do today', tasks: [] },
      { key: 'week', label: 'Do next week', tasks: [] },
      { key: 'later', label: 'Do later', tasks: [] },
    ];
    const by = Object.fromEntries(out.map((b) => [b.key, b]));
    for (const t of list) {
      const k = !t.dueOn ? 'recent' : t.dueOn <= today ? 'today' : t.dueOn <= weekEnd ? 'week' : 'later';
      by[k].tasks.push(t);
    }
    return out;
  }
  const buckets = new Map();
  const push = (k, label, t) => {
    if (!buckets.has(k)) buckets.set(k, { key: k, label, tasks: [] });
    buckets.get(k).tasks.push(t);
  };
  for (const t of list) {
    if (group === 'status') push(t.status || 'not_started', STATUS_META[t.status]?.label || t.status, t);
    else if (group === 'priority') push(t.priority || 'low', (t.priority || 'low').replace(/^\w/, (c) => c.toUpperCase()), t);
    else if (group === 'assignee') push(t.assigneeId || '—', ctx.nameOf ? ctx.nameOf(t.assigneeId) : (t.assigneeId || 'Unassigned'), t);
    else if (group === 'project') push(t.projectId || '—', ctx.projectName?.(t.projectId) || 'No project', t);
    else if (group === 'department') push(t.departmentId || '—', ctx.deptName?.(t.departmentId) || 'No department', t);
    else if (group === 'date') push(t.dueOn || '—', t.dueOn || 'No due date', t);
    else push('all', '', t);
  }
  let arr = [...buckets.values()];
  if (group === 'status') arr.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
  if (group === 'priority') arr.sort((a, b) => PRIORITY_ORDER.indexOf(a.key) - PRIORITY_ORDER.indexOf(b.key));
  return arr;
}

export function taskStats(list) {
  const total = list.length;
  const completed = list.filter((t) => t.completed).length;
  const inProgress = list.filter((t) => t.status === 'in_progress' && !t.completed).length;
  const overdue = list.filter((t) => t.dueOn && t.dueOn < todayISO() && !t.completed).length;
  return { total, completed, inProgress, overdue, pct: total ? Math.round((completed / total) * 100) : 0 };
}

// ── Dates ────────────────────────────────────────────────────────────────────
// One date format for the whole module: mm/dd/yyyy. The views previously each
// rolled their own (`Jul 15`, `15 July 2026`, locale default…), so a task's due
// date read differently depending on which screen you were looking at.
// `en-US` is pinned explicitly — the browser locale must not decide this.
const asDate = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === 'string' && v.length <= 10 ? `${v}T00:00:00` : v);
  return isNaN(d) ? null : d;
};

/** mm/dd/yyyy — e.g. 07/15/2026. Returns '' for empty, the raw value if unparseable. */
export function fmtDate(v) {
  const d = asDate(v);
  if (!d) return v || '';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

/** mm/dd/yyyy, h:mm AM — for activity/comment timestamps. */
export function fmtDateTime(v) {
  const d = asDate(v);
  if (!d) return v || '';
  return d.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
