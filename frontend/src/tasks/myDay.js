// Tasks > My Day (Neil, Oct 22 2026) - Microsoft Planner / To Do's "My Day":
// a short, personal list for today. It starts each day with the tasks
// assigned to me that are due today, plus anything I add, and empties at MY
// local midnight. The tasks themselves are never changed by it, and nobody
// else sees it. The server keeps it (routers/task_my_day.py); this file is the
// browser's copy.
//
// One copy per tab, shared by everything that shows it - the My Day tab, the
// drawer's sun toggle, a list row's menu - so adding a task from the drawer
// shows on the tab without a refetch. Changes are optimistic and go back,
// with a notice, if the server refuses them.
//
// Membership and order are separate, as on the server:
// - Picks (`addedIds`) are only what the person put on the list themselves.
// - Due-today tasks are the person's tasks due today, less the ones they
//   took off (`dismissedIds`). They are never stored as picks, so one leaves
//   the list by itself when it is reassigned or its date moves.
// - `orderIds` is only for sorting: a reorder writes it and nothing else.
//   Named ids come first in that order; the rest follow (picks newest first,
//   then due-today tasks).
// The list on screen is composed from the server's answer AND the live task
// store: a due-today task leaves the moment the store says it is no longer
// mine and due today, and one that becomes so joins, without a refetch.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { todayISO, taskAssignees } from './lib';
import { formatDate, formatWeekday } from '../lib/datetime';

// The suggestion groups, in the server's order, with what the panel calls them.
export const SUGGESTION_GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'dueTomorrow', label: 'Due Tomorrow' },
  { key: 'inProgress', label: 'In Progress' },
  { key: 'recentlyAssigned', label: 'Recently Assigned' },
];

// A focused tab re-reads the list when its copy is older than this (other
// tabs, other people's changes). The one-minute timer only checks the date.
export const STALE_MS = 5 * 60 * 1000;

const EMPTY = Object.freeze({
  email: '', day: '', status: 'idle', error: '',
  addedIds: [], dismissedIds: [], orderIds: [], serverOrder: [], serverTasks: {}, suggestions: [],
  loadedAt: 0,
});

let state = EMPTY;
const listeners = new Set();
// Bumped by every local change. A server answer that started before the
// latest change is not applied over it (two quick adds, a slow load).
let seq = 0;
let inflight = null;

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
}
const subscribe = (f) => { listeners.add(f); return () => listeners.delete(f); };
const snapshot = () => state;

/** Forget everything (tests; a different person signing in). */
export function resetMyDay() {
  state = EMPTY;
  seq = 0;
  inflight = null;
  listeners.forEach((f) => f());
}
export const myDaySnapshot = snapshot;

function fromPayload(p) {
  const body = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  const serverTasks = {};
  const tasks = Array.isArray(body.tasks) ? body.tasks.filter((t) => t?.id) : [];
  for (const t of tasks) serverTasks[t.id] = t;
  const suggestions = (Array.isArray(body.suggestions) ? body.suggestions : []).map((g) => ({
    key: g?.key || '',
    ids: (Array.isArray(g?.tasks) ? g.tasks : []).filter((t) => t?.id).map((t) => {
      if (!serverTasks[t.id]) serverTasks[t.id] = t;
      return t.id;
    }),
  }));
  return {
    status: 'ready', error: '', loadedAt: Date.now(),
    addedIds: Array.isArray(body.addedIds) ? body.addedIds : [],
    dismissedIds: Array.isArray(body.dismissedIds) ? body.dismissedIds : [],
    orderIds: Array.isArray(body.orderIds) ? body.orderIds : [],
    serverOrder: tasks.map((t) => t.id),
    serverTasks, suggestions,
  };
}

/** Make sure the copy is for this person and today - a new day starts empty
 *  (that IS the midnight reset). True when it had to switch. */
function onToday(email) {
  const day = todayISO();
  if (state.email === email && state.day === day) return false;
  seq += 1;           // whatever was in flight belongs to the old day
  inflight = null;
  setState({ ...EMPTY, email, day, status: 'loading' });
  return true;
}

/** Load today's list. Cached for the day; `force` re-reads it in the
 *  background (the list stays on screen meanwhile). */
export function loadMyDay(email, { force = false } = {}) {
  if (!email) return Promise.resolve();
  const switched = onToday(email);
  if (!switched && !force && (state.status === 'ready' || inflight)) return inflight?.promise || Promise.resolve();
  if (inflight && !force) return inflight.promise;
  const { day } = state;
  const started = seq;
  if (state.status !== 'ready') setState({ status: 'loading', error: '' });
  // Through a promise, so a missing or throwing api function lands in catch.
  const promise = Promise.resolve().then(() => api.getMyDay(day)).then((p) => {
    if (started !== seq || state.email !== email || state.day !== day) return;
    setState(fromPayload(p));
  }).catch((e) => {
    if (state.email !== email || state.day !== day) return;
    if (state.status !== 'ready') setState({ status: 'error', error: e?.message || 'Could not load My Day.' });
  }).finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { promise };
  return promise;
}

/** The midnight check, run on focus / visibility and once a minute while My
 *  Day is open: a new local date resets and reloads; on focus, a copy older
 *  than STALE_MS is quietly re-read. Nothing is fetched otherwise. */
export function checkMyDayClock(email, { focus = false } = {}) {
  if (!email || !state.email) return null;
  if (state.day && state.day !== todayISO()) return loadMyDay(email);
  if (focus && state.status === 'ready' && Date.now() - state.loadedAt > STALE_MS) return loadMyDay(email, { force: true });
  return null;
}

// One optimistic change: apply `change` to the copy now, send it, take the
// server's answer if nothing newer happened, put the copy back if it fails.
function mutate(email, change, send) {
  onToday(email);
  const before = state;
  const mine = ++seq;
  setState(change(state));
  const { day } = state;
  return Promise.resolve().then(() => send(day)).then((p) => {
    if (mine === seq && state.day === day && state.email === email) setState(fromPayload(p));
    return p;
  }).catch((e) => {
    if (state.email === email && state.day === day) {
      if (e?.status === 409) {
        // Another tab already started a new day: start over from the server.
        seq += 1;
        setState({ ...EMPTY, email, day: todayISO(), status: 'loading' });
        loadMyDay(email, { force: true });
      } else if (mine === seq && before.status === 'ready') {
        setState({
          addedIds: before.addedIds, dismissedIds: before.dismissedIds, orderIds: before.orderIds, serverOrder: before.serverOrder,
          serverTasks: before.serverTasks, suggestions: before.suggestions,
        });
      } else {
        // Newer changes are on screen, or the list never loaded: re-read the truth.
        loadMyDay(email, { force: true });
      }
    }
    throw e;
  });
}

const without = (ids, id) => ids.filter((x) => x !== id);
const dropFromSuggestions = (groups, id) => groups.map((g) => ({ ...g, ids: without(g.ids, id) }));

/** Put a task on top as a pick. `pick: false` only takes it off
 *  `dismissedIds` - a due-today task put back (Undo) comes back as one. */
export function addToMyDay(email, task, { pick = true } = {}) {
  const id = task?.id;
  if (!email || !id) return Promise.resolve();
  return mutate(email, (s) => (pick ? {
    addedIds: [id, ...without(s.addedIds, id)],
    dismissedIds: without(s.dismissedIds, id),
    orderIds: [id, ...without(s.orderIds, id)],
    serverOrder: [id, ...without(s.serverOrder, id)],
    serverTasks: { ...s.serverTasks, [id]: s.serverTasks[id] || task },
    suggestions: dropFromSuggestions(s.suggestions, id),
  } : {
    dismissedIds: without(s.dismissedIds, id),
    serverOrder: [...without(s.serverOrder, id), id],
    serverTasks: { ...s.serverTasks, [id]: s.serverTasks[id] || task },
  }), (day) => api.addToMyDay(day, id, pick));
}

export function removeFromMyDay(email, id) {
  if (!email || !id) return Promise.resolve();
  return mutate(email, (s) => ({
    addedIds: without(s.addedIds, id),
    dismissedIds: [...without(s.dismissedIds, id), id],
    orderIds: without(s.orderIds, id),
    serverOrder: without(s.serverOrder, id),
  }), (day) => api.removeFromMyDay(day, id));
}

/** `ids` = the list in its new order. Only the order changes: nothing
 *  becomes a pick and nothing leaves. */
export function reorderMyDay(email, ids) {
  if (!email) return Promise.resolve();
  return mutate(email, (s) => {
    const named = [...new Set(ids)];
    const set = new Set(named);
    return { orderIds: [...named, ...s.orderIds.filter((x) => !set.has(x))] };
  }, (day) => api.reorderMyDay(day, ids));
}

// ── Composition (pure - tested in myDay.test.jsx) ──────────────────────────
const dueDay = (t) => String(t?.dueOn || '').slice(0, 10);

/** Whether a task is on today's list by itself: mine and due today. */
export function dueTodayForMe(t, me, day) {
  return !!t && !!me && dueDay(t) === day && taskAssignees(t).includes(me);
}

/**
 * The list on screen: picks (newest first), then my due-today tasks (the
 * server's, then any the store has since made due today), sorted by
 * `orderIds` where it names them, with live task rows from the store where
 * it has them. Open tasks first, finished ones after them, each in list order.
 */
export function composeMyDay(s, { tasks = [], taskById = {}, me = '' } = {}) {
  const day = s.day;
  const live = (id) => taskById[id] || s.serverTasks[id];
  const picks = s.addedIds.filter((id) => live(id));
  const pickSet = new Set(picks);
  const dismissed = new Set(s.dismissedIds);
  const auto = [];
  const autoSet = new Set();
  const take = (id) => { if (!pickSet.has(id) && !autoSet.has(id) && !dismissed.has(id)) { autoSet.add(id); auto.push(id); } };
  for (const id of s.serverOrder) {
    if (pickSet.has(id)) continue;
    const fresh = taskById[id];
    // The store's copy is the newer one: if it says this is no longer mine
    // and due today, it leaves.
    if (fresh ? dueTodayForMe(fresh, me, day) : !!s.serverTasks[id]) take(id);
  }
  if (s.status === 'ready' && day) for (const t of tasks) if (dueTodayForMe(t, me, day)) take(t.id);
  const base = [...picks, ...auto];
  const on = new Set(base);
  const first = s.orderIds.filter((id) => on.has(id));
  const firstSet = new Set(first);
  const rows = [...first, ...base.filter((id) => !firstSet.has(id))].map(live).filter(Boolean);
  const open = rows.filter((t) => !t.completed);
  const done = rows.filter((t) => t.completed);
  return { rows: [...open, ...done], open, done, ids: new Set(rows.map((t) => t.id)) };
}

/** Suggestion groups with live rows, leaving out what is on the list now or
 *  already finished; empty groups are kept (the panel hides them). */
export function composeSuggestions(s, onList, taskById = {}) {
  return SUGGESTION_GROUPS.map((g) => {
    const ids = s.suggestions.find((x) => x.key === g.key)?.ids || [];
    const rows = ids.map((id) => taskById[id] || s.serverTasks[id])
      .filter((t) => t && !t.completed && !onList.has(t.id));
    return { ...g, rows };
  });
}

/** Move `id` by `delta` places within `ids` (clamped). */
export function moveId(ids, id, delta) {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  if (to === from) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** "Thursday, 10/22/2026" - the weekday, then the date the person's way. */
export function myDayDateLabel(day) {
  return `${formatWeekday(day)}, ${formatDate(day)}`;
}

/** "3 of 7 done". */
export function progressLabel(done, total) {
  return `${done} of ${total} done`;
}

// ── The hook ────────────────────────────────────────────────────────────────
/**
 * My Day for the signed-in person. Loads once per day on first use.
 * `add` / `remove` / `reorder` are optimistic; a refusal puts the list back
 * and says so in the module's notice spot. `remove` offers Undo.
 */
export function useMyDay() {
  const store = useTasks();
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const me = String(store?.myEmail || '').toLowerCase();
  const { tasks, taskById, notify, offerUndo } = store || {};

  useEffect(() => { if (me) loadMyDay(me); }, [me]);

  const mineNow = s.email === me && !!me;
  const view = mineNow ? s : { ...EMPTY, status: me ? 'loading' : 'idle' };
  const list = useMemo(() => composeMyDay(view, { tasks: tasks || [], taskById: taskById || {}, me }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, tasks, taskById, me, mineNow]);
  const suggestions = useMemo(() => composeSuggestions(view, list.ids, taskById || {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, list, taskById, mineNow]);

  const fail = useCallback((what) => () => notify?.(`Could not ${what}. Please try again.`), [notify]);
  const add = useCallback((task) => addToMyDay(me, task).catch(fail('add that to My Day')), [me, fail]);
  // Undo puts it back as what it was - a pick, or a due-today task - and
  // where it was.
  const remove = useCallback((task, { undo = true } = {}) => {
    const id = task?.id;
    const order = list.rows.map((t) => t.id);
    const wasPick = mineNow && s.addedIds.includes(id);
    return removeFromMyDay(me, id).then(() => {
      if (undo && offerUndo) {
        offerUndo(`Removed "${String(task?.title || '').slice(0, 40)}" from My Day`, () => {
          addToMyDay(me, task, { pick: wasPick }).then(() => reorderMyDay(me, order)).catch(fail('put that back'));
        });
      }
    }, fail('remove that from My Day'));
  }, [me, list, s, mineNow, offerUndo, fail]);
  const reorder = useCallback((ids) => reorderMyDay(me, ids).catch(fail('reorder My Day')), [me, fail]);
  const reload = useCallback(() => loadMyDay(me, { force: true }), [me]);
  const has = useCallback((id) => list.ids.has(id), [list]);

  return {
    day: view.day || todayISO(), status: view.status, error: view.error,
    rows: list.rows, open: list.open, done: list.done, total: list.rows.length,
    suggestions, has, add, remove, reorder, reload, me,
  };
}
