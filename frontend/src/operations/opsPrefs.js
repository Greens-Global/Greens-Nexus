// Operations: what each person keeps for themselves, in their profile (the
// /task-prefs document every table preference lives in), so it follows them
// from the office computer to a laptop (Oct 28 2026 call with Neil):
//   ops-cols     - every table's columns: order, hidden, sort, filters and
//                  added preset columns (columnControls.js), by table key
//   ops-reports  - the Reports Center: memorized reports (B11) and the reports
//                  pinned under Monthly Required (B12)
//   ops-dash     - the Dashboard: the person's cards and filter bar (B1, B2)
// Three table keys in all: the profile document allows 40 tables per person,
// so a table key per report would crowd out the rest of Nexus.
import { useCallback, useMemo } from 'react';
import { useTableValue } from '../tasks/tableCols';
import { blankShape, cleanShape } from './columnControls';

const EMPTY = Object.freeze({});
const MAX_MEMORIZED = 60;

/** [shape, setShape] for one table. `setShape` takes a shape or an updater. */
export function useOpsColumns(tableKey) {
  const [all, setAll] = useTableValue('ops-cols', 'data', EMPTY);
  const shape = useMemo(() => cleanShape(all?.[tableKey]), [all, tableKey]);
  const set = useCallback((next) => setAll((cur) => {
    const prev = cleanShape(cur?.[tableKey]);
    const value = typeof next === 'function' ? next(prev) : next;
    const rest = { ...(cur || {}) };
    if (!value) delete rest[tableKey];
    else rest[tableKey] = cleanShape(value);
    return rest;
  }), [setAll, tableKey]);
  return [shape, set];
}

// The Monthly Required section before anyone pins or unpins (B12, in this order).
// Exceptions is not built yet (P3 pending) and shows as Coming Soon.
export const EXCEPTIONS = 'exceptions';
export const DEFAULT_PINS = ['management-summary', 'ar-activity', 'credits-issued', EXCEPTIONS, 'occupancy-statistics'];

const id = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The Reports Center's own document: { memorized: [], pinned: [] | undefined }. */
export function useReportsCenter() {
  const [doc, setDoc] = useTableValue('ops-reports', 'data', EMPTY);
  const memorized = useMemo(() => (Array.isArray(doc?.memorized) ? doc.memorized.filter((m) => m && m.id && m.report) : []), [doc]);
  const pinned = useMemo(() => (Array.isArray(doc?.pinned) ? doc.pinned : DEFAULT_PINS), [doc]);
  const patch = useCallback((fn) => setDoc((cur) => ({ ...(cur || {}), ...fn(cur || {}) })), [setDoc]);
  const curMemorized = (cur) => (Array.isArray(cur.memorized) ? cur.memorized : []);
  const curPinned = (cur) => (Array.isArray(cur.pinned) ? cur.pinned : DEFAULT_PINS);

  const memorize = useCallback(({ name, report, choices, shape }) => {
    const row = { id: id(), name: String(name || '').trim().slice(0, 80), report, choices, shape: cleanShape(shape || blankShape()),
      savedAt: new Date().toISOString() };
    patch((cur) => ({ memorized: [row, ...curMemorized(cur)].slice(0, MAX_MEMORIZED) }));
    return row;
  }, [patch]);
  const update = useCallback((memId, changes) => patch((cur) => ({
    memorized: curMemorized(cur).map((m) => (m.id === memId ? { ...m, ...changes, ...(changes.shape ? { shape: cleanShape(changes.shape) } : {}), savedAt: new Date().toISOString() } : m)),
  })), [patch]);
  const forget = useCallback((memId) => patch((cur) => ({
    memorized: curMemorized(cur).filter((m) => m.id !== memId),
    pinned: curPinned(cur).filter((k) => k !== `m:${memId}`),
  })), [patch]);
  const togglePin = useCallback((key) => patch((cur) => {
    const list = curPinned(cur);
    return { pinned: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] };
  }), [patch]);
  const movePin = useCallback((key, by) => patch((cur) => {
    const list = [...curPinned(cur)];
    const i = list.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return {};
    [list[i], list[j]] = [list[j], list[i]];
    return { pinned: list };
  }), [patch]);
  return { memorized, pinned, memorize, update, forget, togglePin, movePin };
}

/** The Dashboard's own document (B1 / B2). */
export function useOpsDashboard() {
  const [doc, setDoc] = useTableValue('ops-dash', 'data', EMPTY);
  const patch = useCallback((changes) => setDoc((cur) => ({ ...(cur || {}), ...changes })), [setDoc]);
  return [doc || EMPTY, patch];
}

/** Read any table's shape by key (the report list's Download and Schedule,
 *  which run a report without opening it, follow the person's columns too). */
export function useOpsColumnShapes() {
  const [all] = useTableValue('ops-cols', 'data', EMPTY);
  return useCallback((tableKey) => cleanShape(all?.[tableKey]), [all]);
}

export const reportTableKey = (reportKey) => `report:${reportKey}`;
