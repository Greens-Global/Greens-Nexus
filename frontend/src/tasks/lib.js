// Task Module — pure helpers (ported from nexus/lib/filters.ts + stats.ts).
// Operates on the runtime task shape (email used as person id).
import { PRIORITY_META, STATUS_ORDER, STATUS_META } from './theme';

export const EMPTY_FILTER = {
  assigneeIds: [], statuses: [], priorities: [], departmentIds: [], projectIds: [],
  tags: [], due: 'any', dueFrom: null, dueTo: null, search: '',
};

const todayISO = () => new Date().toISOString().slice(0, 10);

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

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const SORTERS = {
  title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  dueOn: (a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999'),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  assignee: (a, b) => (a.assigneeId || '').localeCompare(b.assigneeId || ''),
};

export function sortTasks(list, sort = { key: 'manual', dir: 'asc' }) {
  if (!sort || sort.key === 'manual') return list;   // manual keeps insertion order (source parity)
  const dir = sort.dir === 'asc' ? 1 : -1;
  const fn = SORTERS[sort.key];
  if (!fn) return list;
  return [...list].sort((a, b) => fn(a, b) * dir);
}

const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Group tasks by a GroupBy key. Returns [{ key, label, color?, tasks }].
 * Ported from nexus/lib/filters.ts: status pre-seeds every column (so empty
 * board columns render); date uses semantic buckets (recent/today/week/later).
 */
export function groupTasks(list, group, ctx = {}) {
  if (!group || group === 'none') return [{ key: 'all', label: 'All tasks', tasks: list }];

  const map = new Map();
  const push = (key, label, t, color) => {
    if (!map.has(key)) map.set(key, { key, label, color, tasks: [] });
    map.get(key).tasks.push(t);
  };

  if (group === 'status') {
    for (const s of STATUS_ORDER) map.set(s, { key: s, label: STATUS_META[s].label, color: STATUS_META[s].color, tasks: [] });
    for (const t of list) (map.get(t.status || 'not_started') || map.get('not_started')).tasks.push(t);
    return [...map.values()];
  }

  if (group === 'date') {
    const today = todayISO();
    const weekEnd = addDaysISO(today, 7);
    const buckets = [
      { key: 'recent', label: 'Recently assigned', tasks: [] },
      { key: 'today', label: 'Do today', tasks: [] },
      { key: 'week', label: 'Do next week', tasks: [] },
      { key: 'later', label: 'Do later', tasks: [] },
    ];
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    for (const t of list) {
      const key = !t.dueOn ? 'recent' : t.dueOn <= today ? 'today' : t.dueOn <= weekEnd ? 'week' : 'later';
      byKey[key].tasks.push(t);
    }
    return buckets;
  }

  const nameOf = ctx.nameOf || ((id) => id || 'Unassigned');
  for (const t of list) {
    if (group === 'assignee') push(t.assigneeId || 'none', t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned', t);
    else if (group === 'priority') push(t.priority || 'none', PRIORITY_META[t.priority || 'none'].label, t, PRIORITY_META[t.priority || 'none'].color);
    else if (group === 'project') push(t.projectId || 'none', ctx.projectName?.(t.projectId) || 'No project', t);
    else if (group === 'department') push(t.departmentId || 'none', ctx.deptName?.(t.departmentId) || 'No department', t);
  }
  return [...map.values()];
}

/** computeStats parity: total/inProgress/overdue/noComments/needsReview/completed (+ pct convenience). */
export function taskStats(list) {
  const t = todayISO();
  let inProgress = 0, overdue = 0, noComments = 0, needsReview = 0, completed = 0;
  for (const x of list) {
    if (x.status === 'in_progress') inProgress++;
    if (x.completed) completed++;
    if (!x.completed && x.dueOn && x.dueOn < t) overdue++;
    if (!(x.commentIds || []).length) noComments++;
    if (x.approvalStatus === 'pending') needsReview++;
  }
  const total = list.length;
  return { total, inProgress, overdue, noComments, needsReview, completed, pct: total ? Math.round((completed / total) * 100) : 0 };
}
