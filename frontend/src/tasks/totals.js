// Task Module - column totals for the list view (Neil, Oct 22 2026).
//
// A footer row under each group and one under the whole list. Each number-ish
// column (Time, Actual, a number field, a number/currency/percent formula) can
// show Sum / Average / Min / Max / Count; any other column Count Filled. The
// choice is per person and per project, stored with the rest of their table
// settings (/task-prefs "richlist" -> totals, see routers/task_prefs.py), and
// nothing shows until they turn the row on and pick something. Totals are
// worked out over the rows on screen, so they follow every filter.
import { useCallback } from 'react';
import { useTableValue } from './tableCols';
import { taskAssignees, fmtHours } from './lib';
import { formulaIsNumeric, formatNumberAs } from './formula';

export const NUMBER_AGGS = [
  { key: 'sum', label: 'Sum' },
  { key: 'avg', label: 'Average' },
  { key: 'min', label: 'Min' },
  { key: 'max', label: 'Max' },
  { key: 'count', label: 'Count' },
];
export const OTHER_AGGS = [{ key: 'filled', label: 'Count Filled' }];
const AGG_LABEL = Object.fromEntries([...NUMBER_AGGS, ...OTHER_AGGS].map((a) => [a.key, a.label]));
export const aggLabel = (key) => AGG_LABEL[key] || '';

const HOURS_COLS = new Set(['estimate', 'actual']);
const NO_TOTAL = new Set(['checkbox', 'task']);

/** 'number' (Sum and the rest), 'other' (Count Filled) or null (no total)
 *  for a column. `field` is the custom field when the column is one. */
export function totalKind(colKey, field) {
  if (NO_TOTAL.has(colKey)) return null;
  if (HOURS_COLS.has(colKey)) return 'number';
  if (field) return field.type === 'number' || formulaIsNumeric(field) ? 'number' : 'other';
  return 'other';
}
export const aggsFor = (kind) => (kind === 'number' ? NUMBER_AGGS : kind === 'other' ? OTHER_AGGS : []);

const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** The number a task contributes to a number column, or null. */
export function cellNumber(task, colKey, field, engine) {
  let v;
  if (colKey === 'estimate') v = task.estimateHours;
  else if (colKey === 'actual') v = task.actualHours;
  else if (field?.type === 'formula') {
    const r = engine ? engine.result(task, field) : null;
    v = r && !r.error && typeof r.value === 'number' ? r.value : null;
  } else if (field) v = (task.customFieldValues || {})[field.id];
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Does this task have something in the column? */
export function cellFilled(task, colKey, field, engine) {
  if (field) {
    if (field.type === 'formula') {
      const r = engine ? engine.result(task, field) : null;
      return !!r && !r.error && !blank(r.value);
    }
    if (field.type === 'checkbox') return (task.customFieldValues || {})[field.id] === true;
    return !blank((task.customFieldValues || {})[field.id]);
  }
  switch (colKey) {
    case 'assignee': return taskAssignees(task).length > 0;
    case 'project': return !!task.projectId;
    case 'due': return !!task.dueOn;
    case 'priority': return !!task.priority;
    case 'status': return !!task.status;
    case 'team': return !!task.teamId;
    case 'timeline': return !!(task.startOn || task.dueOn);
    case 'estimate': return cellNumber(task, colKey, null) !== null;
    case 'actual': return cellNumber(task, colKey, null) !== null;
    default: return false;
  }
}

/** The total of `tasks` in one column, or null when there is nothing to
 *  total (an average/min/max over no numbers). */
export function computeTotal(tasks, colKey, agg, { field = null, engine = null } = {}) {
  if (!agg) return null;
  if (agg === 'filled') return (tasks || []).filter((t) => cellFilled(t, colKey, field, engine)).length;
  const nums = [];
  for (const t of tasks || []) { const n = cellNumber(t, colKey, field, engine); if (n !== null) nums.push(n); }
  switch (agg) {
    case 'count': return nums.length;
    case 'sum': return nums.reduce((s, x) => s + x, 0);
    case 'avg': return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
    case 'min': return nums.length ? Math.min(...nums) : null;
    case 'max': return nums.length ? Math.max(...nums) : null;
    default: return null;
  }
}

/** A total as the column would show it: hours as hours, a formula in its own
 *  currency/percent format, counts as whole numbers. */
export function formatTotal(value, agg, colKey, field) {
  if (value === null || value === undefined) return '-';
  if (agg === 'count' || agg === 'filled') return new Intl.NumberFormat('en-US').format(value);
  if (HOURS_COLS.has(colKey)) return fmtHours(value);
  if (field?.type === 'formula') return formatNumberAs(value, field.formulaFormat);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

const EMPTY = {};
/** This person's totals row for one list: { show, cols, setShow, setAgg }.
 *  Keyed by project ('_' = a list on no project), so each project keeps its
 *  own. setAgg(col, '') = None. */
export function useColumnTotals(projectId) {
  const scope = projectId || '_';
  const [all, setAll] = useTableValue('richlist', 'totals', EMPTY);
  const mine = (all && all[scope]) || EMPTY;
  const cols = mine.cols || EMPTY;
  const write = useCallback((next) => {
    setAll((prev) => {
      const out = { ...(prev || {}) };
      if (next.show || Object.keys(next.cols || {}).length) out[scope] = next;
      else delete out[scope];
      return out;
    });
  }, [setAll, scope]);
  const setShow = useCallback((show) => write({ show: !!show, cols }), [write, cols]);
  const setAgg = useCallback((col, agg) => {
    const nextCols = { ...cols };
    if (agg) nextCols[col] = agg; else delete nextCols[col];
    write({ show: true, cols: nextCols });
  }, [write, cols]);
  return { show: !!mine.show, cols, setShow, setAgg };
}
