// Task Module - the module's data OUTSIDE React, so it can be loaded before
// anything renders and survives the provider unmounting.
//
// Why this exists. TasksProvider used to open with one 15-way Promise.all and
// hold `loading` until the slowest call returned, and it threw the lot away on
// unmount - so every trip to Tasks (and every hop between Tasks and Tickets,
// which share the provider) paid the full fifteen-request wait again, staring
// at a spinner the whole time. Two changes fix that:
//
//   1. The collections stream in individually. The first screen only needs
//      tasks + projects + custom statuses, so it paints on those three instead
//      of waiting on saved views, automation rules and the changelog.
//   2. The results are cached at module scope, and the load can be started
//      from anywhere - App warms it at idle right after boot - so by the time
//      anyone clicks Tasks the data is usually already there and the module
//      opens with no spinner at all.
//
// The cache is per page load. Act As and sign-out both reboot the app
// (window.location.assign), so a session's data can never outlive its identity.
import { api } from '../api';

// Collection key -> fetcher. `tasks` returns { tasks, serverTime }: the delta
// cursor the provider polls with, kept alongside the rows it belongs to.
const SOURCES = {
  tasks:            () => api.getTasksDelta('', 'recent'),   // the long-done rest: loadOlderTasks
  projects:         () => api.getTaskProjects(),
  customStatuses:   () => api.getTaskCustomStatuses(),
  portfolios:       () => api.getTaskPortfolios(),
  teams:            () => api.getTaskTeams(),
  tickets:          () => api.getTaskTickets(),
  ticketComponents: () => api.getTicketComponents(),
  savedViews:       () => api.getTaskSavedViews(),
  ticketViews:      () => api.getTicketViews(),
  rules:            () => api.getTaskAutomationRules(),
  templates:        () => api.getTaskTemplates(),
  projectTemplates: () => api.getTaskProjectTemplates(),
  customFields:     () => api.getTaskCustomFields(),
  memberRequests:   () => api.getTaskMemberRequests(),
  intakeForms:      () => api.getTaskIntakeForms(),
  changelog:        () => api.getTaskChangelog(),
};

// What the first screen actually renders from. A saved view or an automation
// rule arriving half a second later is invisible; a missing task list is not.
export const FIRST_PAINT = ['tasks', 'projects', 'customStatuses'];

export const COLLECTION_KEYS = Object.keys(SOURCES);

const emptyFor = (key) => (key === 'tasks' ? { tasks: [], serverTime: '' } : []);
const emptyAll = () => Object.fromEntries(COLLECTION_KEYS.map((k) => [k, emptyFor(k)]));

let cache = null;          // last known value per collection
let complete = false;      // a full load has finished at least once
const inflight = new Map();  // key -> promise, so a prefetch and a mount share one request

// A failed collection keeps whatever we had rather than blanking the screen -
// same spirit as the .catch(() => []) the provider used to do inline.
function fetchOne(key) {
  const running = inflight.get(key);
  if (running) return running;
  const p = SOURCES[key]()
    .then((v) => { cache[key] = v ?? emptyFor(key); })
    .catch(() => { /* keep the previous value */ })
    .then(() => { inflight.delete(key); return cache[key]; });
  inflight.set(key, p);
  return p;
}

/** Load every collection at once. `onPart(key, value)` fires as each lands, so
 *  a caller can paint as soon as FIRST_PAINT is in. Resolves when all are done. */
export function loadTaskData(onPart) {
  if (!cache) cache = emptyAll();
  return Promise.all(COLLECTION_KEYS.map((k) => fetchOne(k).then((v) => { onPart?.(k, v); })))
    .then(() => { complete = true; });
}

/** Tasks completed over 60 days ago (11/05/2026) - left out of the first load
 *  so a screen paints on the 2-3 thousand that matter; the provider fetches
 *  them right behind it. Resolves to [] on failure. */
export const loadOlderTasks = () => api.getTasksDelta('', 'older').then((r) => r?.tasks || []).catch(() => []);

// The first load comes in two parts (11/05/2026, routers/tasks.py
// RECENT_COMPLETED_DAYS): everything but the tasks completed over 60 days
// ago, then those. A long-done task already held survives the first part's
// replace, so a remount never blinks them away while the second is in flight.
// 61, not 60: the server cuts at a date (UTC midnight 60 days back), so a task
// this side calls long-done is always in its `older` part and never dropped.
const LONG_DONE_MS = 61 * 864e5;
const longDone = (t) => !!(t.completed && t.completedAt && Date.parse(t.completedAt) < Date.now() - LONG_DONE_MS);
export const withRecent = (prev, recent) => {
  const ids = new Set(recent.map((t) => t.id));
  return [...recent, ...prev.filter((t) => longDone(t) && !ids.has(t.id))];
};
export const withOlder = (prev, older) => {
  const olderIds = new Set(older.map((t) => t.id));
  const base = prev.filter((t) => !longDone(t) || olderIds.has(t.id));   // one dropped from `older` is gone
  const have = new Set(base.map((t) => t.id));
  return [...base, ...older.filter((t) => !have.has(t.id))];            // a held copy is as new or newer
};

/** Warm the cache with nothing mounted - called at idle after boot. A no-op
 *  once the data is there; the provider refreshes it on mount either way. */
export function prefetchTaskData() {
  if (complete) return Promise.resolve();
  return loadTaskData().catch(() => {});
}

/** The cached collections, or null if a full load hasn't finished yet. A
 *  half-filled cache deliberately reads as "nothing" - rendering an empty task
 *  list as though it were the real one is worse than a moment of spinner. */
export const taskSnapshot = () => (complete ? cache : null);

/** Write the provider's live state back, so an edit made in this session is
 *  what the next mount shows (rather than the values as first fetched). */
export function rememberTaskData(patch) {
  cache = { ...(cache || emptyAll()), ...patch };
}
