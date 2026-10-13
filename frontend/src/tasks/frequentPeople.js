// "Frequent" in the Collaborators pickers (Neil, Oct 12 2026): you work with
// the same handful of people most of the time, so they come first, above the
// full A-Z list.
//
// Worked out from the task store already in memory - no endpoint, no extra
// request, and it follows the store live. A person scores one point for each
// task from the last six months that you were both on (owner, assignee or
// collaborator); the last 30 days count double, so the list follows who you
// work with now. Two shared tasks is the floor, so a one-off never shows.
// A task and its subtasks are one piece of work: they count once, at their
// most recent, so a parent with ten subtasks does not outrank a colleague
// you have shared ten separate tasks with.
import { useMemo } from 'react';
import { useTasks } from './TasksContext';
import { taskAssignees, isSection } from './lib';

const DAY_MS = 24 * 60 * 60 * 1000;
export const FREQUENT_WINDOW_DAYS = 183;
export const FREQUENT_RECENT_DAYS = 30;
export const FREQUENT_MIN_SHARED = 2;
export const FREQUENT_LIMIT = 5;

const lower = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

function peopleOn(task) {
  const all = [task.ownerId, ...taskAssignees(task), ...(task.followerIds || [])].map(lower).filter(Boolean);
  return new Set(all);
}

// Last touched, else created. A task with neither has no place in "recent".
function whenOf(task) {
  const t = Date.parse(task.modifiedAt || task.createdAt || '');
  return Number.isFinite(t) ? t : null;
}

/** Emails of the people `me` shares the most recent tasks with, best first. */
export function frequentCollaborators(tasks, me, { now = Date.now(), limit = FREQUENT_LIMIT } = {}) {
  const self = lower(me);
  if (!self || !Array.isArray(tasks)) return [];
  const since = now - FREQUENT_WINDOW_DAYS * DAY_MS;
  const recent = now - FREQUENT_RECENT_DAYS * DAY_MS;
  // root task id -> person -> best weight seen on that piece of work
  const work = new Map();
  for (const task of tasks) {
    if (!task || isSection(task)) continue;
    const at = whenOf(task);
    if (at == null || at < since) continue;
    const on = peopleOn(task);
    if (!on.has(self)) continue;
    const weight = at >= recent ? 2 : 1;
    const root = task.parentTaskId || task.id;
    if (!work.has(root)) work.set(root, new Map());
    const people = work.get(root);
    for (const em of on) {
      if (em !== self && (people.get(em) || 0) < weight) people.set(em, weight);
    }
  }
  const score = new Map();
  const shared = new Map();
  for (const people of work.values()) {
    for (const [em, weight] of people) {
      score.set(em, (score.get(em) || 0) + weight);
      shared.set(em, (shared.get(em) || 0) + 1);
    }
  }
  return [...score.entries()]
    .filter(([em]) => shared.get(em) >= FREQUENT_MIN_SHARED)
    // Ties go alphabetically, so the list does not shuffle between renders.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([em]) => em);
}

/** The frequent emails, as rows of `people` (anyone not in the list is dropped). */
export function frequentRows(people, frequent, limit = FREQUENT_LIMIT) {
  if (!frequent?.length || !people?.length) return [];
  const byEmail = new Map(people.map((p) => [p.email, p]));
  return frequent.map((em) => byEmail.get(em)).filter(Boolean).slice(0, limit);
}

export function useFrequentCollaborators() {
  const { tasks, myEmail } = useTasks();
  // A few spare: someone who has left the people list drops out in
  // frequentRows, and the next person moves up so the group still holds five.
  return useMemo(() => frequentCollaborators(tasks, myEmail, { limit: FREQUENT_LIMIT * 2 }), [tasks, myEmail]);
}
