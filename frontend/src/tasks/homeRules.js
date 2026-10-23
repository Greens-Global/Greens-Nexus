// Tasks Home's rules (Neil, Oct 23 2026 Home pass) - pure functions over the
// store's task rows, so the tiles, the Tasks card groups, Projects at Risk and
// Team Workload are tested without a screen. Dates are LOCAL calendar dates
// (YYYY-MM-DD); `today` is passed in so a test can pin it.
import { formatDate, formatWeekday } from '../lib/datetime';
import { taskAssignees } from './lib';

export const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return localISO(d); };
const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');
// "This week" is the next 7 days, today included (today .. today+6) -
// the tile, the Tasks card's group, Week Ahead's seven cells, Projects at
// Risk and Team Workload all mean the same span.
export const WEEK_LAST = 6;
export const weekEnd = (today) => addDays(today, WEEK_LAST);
const isOpen = (t) => !t.completed && t.status !== 'missed';

// ── The live-work rule ──────────────────────────────────────────────────────
// The SAME rule as the dashboard's My Open Tasks (backend
// routers/my_work.task_focus_bucket): in progress counts whatever its date; a
// repeating task counts once its date has come; a one-off counts when overdue
// or due within FOCUS_DAYS; the rest is named, not counted. Keep the two in step.
export const FOCUS_DAYS = 30;
export const isRecurring = (t) => t?.status === 'recurring'
  || !!(t?.recurrence && typeof t.recurrence === 'object' && !Array.isArray(t.recurrence) && t.recurrence.freq);

export function focusBucket(t, today) {
  if (t.status === 'in_progress') return 'focus';
  const due = day(t.dueOn);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(due);
  if (isRecurring(t)) return dated && due <= today ? 'focus' : 'recurring';
  if (!dated) return 'undated';
  return due <= addDays(today, FOCUS_DAYS) ? 'focus' : 'later';
}

/** { focus, undated, recurring, later } over open tasks - the dashboard KPI's
 *  three numbers, named the way the dashboard tile names them. */
export function focusCounts(tasks, today) {
  const c = { focus: 0, undated: 0, recurring: 0, later: 0 };
  for (const t of tasks) if (isOpen(t)) c[focusBucket(t, today)] += 1;
  return c;
}

// ── The four tiles ──────────────────────────────────────────────────────────
// Overdue / Due Today / This Week / In Progress. No "of N" - a fraction of
// every task you ever had said nothing (the old tiles divided by the lot,
// finished ones included).
export function tileCounts(tasks, today) {
  const week = weekEnd(today);
  const open = tasks.filter(isOpen);
  return {
    overdue: open.filter((t) => day(t.dueOn) && day(t.dueOn) < today).length,
    today: open.filter((t) => day(t.dueOn) === today).length,
    week: open.filter((t) => day(t.dueOn) >= today && day(t.dueOn) <= week).length,
    inProgress: open.filter((t) => t.status === 'in_progress').length,
  };
}

// ── The Tasks card's Upcoming groups ────────────────────────────────────────
/** Which group a dated open task sits under. */
export function dueGroup(iso, today) {
  const d = day(iso);
  if (d === today) return 'today';
  if (d === addDays(today, 1)) return 'tomorrow';
  if (d <= weekEnd(today)) return 'week';
  return 'later';
}
export const GROUP_LABEL = { today: 'Today', tomorrow: 'Tomorrow', week: 'This Week', later: 'Later', undated: 'No Due Date' };
const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
export const byDueThenPriority = (a, b) => (day(a.dueOn) || '9999').localeCompare(day(b.dueOn) || '9999')
  || (PRIO_RANK[a.priority] ?? 2) - (PRIO_RANK[b.priority] ?? 2)
  || String(a.title || '').localeCompare(String(b.title || ''));

/** Upcoming in the picked window (today .. today+days), grouped, plus the
 *  open tasks with no due date, which the card folds away under one header. */
export function upcomingGroups(tasks, today, days) {
  const end = addDays(today, days);
  const open = tasks.filter(isOpen);
  const dated = open.filter((t) => day(t.dueOn) >= today && day(t.dueOn) <= end).sort(byDueThenPriority);
  const groups = [];
  for (const t of dated) {
    const g = dueGroup(t.dueOn, today);
    const last = groups[groups.length - 1];
    if (last && last.key === g) last.rows.push(t); else groups.push({ key: g, label: GROUP_LABEL[g], rows: [t] });
  }
  const undated = open.filter((t) => !day(t.dueOn)).sort(byDueThenPriority);
  return { groups, undated };
}

/** A row's date the way people say it: Today, Tomorrow, Yesterday, the
 *  weekday within the coming week, else MM/DD/YYYY. */
export function dueLabel(iso, today) {
  const d = day(iso);
  if (!d) return '';
  if (d === today) return 'Today';
  if (d === addDays(today, 1)) return 'Tomorrow';
  if (d === addDays(today, -1)) return 'Yesterday';
  if (d > today && d <= addDays(today, 6)) return formatWeekday(new Date(`${d}T00:00:00`), 'short');
  return formatDate(d);
}

/** "Fri, 10/23/2026" - a chart cell's tooltip and the filter chip. */
export const dayTitle = (iso) => `${formatWeekday(new Date(`${day(iso)}T00:00:00`), 'short')}, ${formatDate(day(iso))}`;

/** Su..Sa for a chart's axis, from the local date (no toLocale* call). */
const SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export const twoLetterDay = (iso) => SHORT[new Date(`${day(iso)}T00:00:00`).getDay()];

// ── Completed this week vs last week ────────────────────────────────────────
export const completedOn = (t) => (t.completedAt ? localISO(new Date(t.completedAt)) : '');
export function completedWeeks(tasks, today) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const iso = addDays(today, -i);
    days.push({ iso, n: tasks.filter((t) => t.completed && completedOn(t) === iso).length });
  }
  const from = addDays(today, -13), to = addDays(today, -7);
  const lastWeek = tasks.filter((t) => t.completed && completedOn(t) >= from && completedOn(t) <= to).length;
  return { days, total: days.reduce((s, d) => s + d.n, 0), lastWeek };
}
/** "1 needs you now" / "4 need you now". */
export const needsYouNow = (n) => `${n} need${n === 1 ? 's' : ''} you now`;

export function versusLastWeek(total, lastWeek) {
  if (total === lastWeek) return 'Same as last week';
  const diff = Math.abs(total - lastWeek);
  return `${diff} ${total > lastWeek ? 'more' : 'fewer'} than last week`;
}

// ── Projects at Risk ────────────────────────────────────────────────────────
/** Projects I am part of (own, member, follow, bookmarked, on one of my
 *  teams, or have a task or subtask in) with overdue or due-this-week work,
 *  worst first. Counts are the project's top-level tasks the person can see
 *  - what its list shows. */
export function projectsAtRisk(projects, tasks, { me, bookmarks, today, teamProjectIds, limit = 5 }) {
  const week = weekEnd(today);
  const mineIn = new Set(teamProjectIds || []);
  const stats = {};
  // A subtask's projectId is blank by convention - it is in its parent's.
  const projectOfId = new Map(tasks.map((t) => [t.id, t.projectId || '']));
  for (const t of tasks) {
    if (t.type === 'section') continue;
    const pid = t.projectId || (t.parentTaskId ? projectOfId.get(t.parentTaskId) : '') || '';
    if (!pid) continue;
    if (taskAssignees(t).includes(me)) mineIn.add(pid);
    if (t.parentTaskId || !t.projectId) continue;
    const s = stats[t.projectId] || (stats[t.projectId] = { total: 0, done: 0, overdue: 0, dueWeek: 0 });
    s.total += 1;
    if (t.completed) { s.done += 1; continue; }
    if (!isOpen(t)) continue;
    const d = day(t.dueOn);
    if (d && d < today) s.overdue += 1;
    else if (d && d <= week) s.dueWeek += 1;
  }
  const mine = (p) => p.ownerId === me || (p.memberIds || []).includes(me) || (p.followerIds || []).includes(me)
    || bookmarks?.has?.(p.id) || mineIn.has(p.id);
  return (projects || [])
    .filter((p) => !p.archived && mine(p))
    .map((p) => ({ p, ...(stats[p.id] || { total: 0, done: 0, overdue: 0, dueWeek: 0 }) }))
    .filter((x) => x.overdue > 0 || x.dueWeek > 0)
    .sort((a, b) => b.overdue - a.overdue || b.dueWeek - a.dueWeek || String(a.p.name).localeCompare(String(b.p.name)))
    .slice(0, limit);
}

// ── Team Workload ───────────────────────────────────────────────────────────
/** Each teammate's open / overdue / due-this-week count, from the tasks the
 *  viewer can already see (the store holds nothing else). Shown to everyone
 *  (Neil, Oct 23 2026). Most overdue first, then most open. */
export function teamWorkload(memberEmails, tasks, today) {
  const week = weekEnd(today);
  const rows = new Map(memberEmails.map((e) => [e, { email: e, open: 0, overdue: 0, week: 0 }]));
  for (const t of tasks) {
    if (!isOpen(t) || t.type === 'section') continue;
    const d = day(t.dueOn);
    for (const e of taskAssignees(t)) {
      const r = rows.get(e);
      if (!r) continue;
      r.open += 1;
      if (d && d < today) r.overdue += 1;
      else if (d && d <= week) r.week += 1;
    }
  }
  return [...rows.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.email.localeCompare(b.email));
}
