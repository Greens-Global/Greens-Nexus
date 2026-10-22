// Task Module - conditional row colors, the screen side (Neil, Oct 22 2026).
//
// colorRules.js decides which rule colors a task; this file carries that
// answer to the views:
//   - useRuleContext: what the evaluator and the editor read about a scope.
//   - useRowColorScope: one screen's rules in force, the taskId -> color map
//     (memoized, local "today") and the person's Show Row Colors switch and
//     legend state (their profile, default on).
//   - RowColorsProvider / useRowColor / useRowColorMap: the map handed down
//     by context, so the list, board, calendar and timeline read it without
//     prop threading - and a view outside a provider (Home widgets) is simply
//     uncolored.
//   - rowColorAttrs / boldTitleStyle / srOnly: how a colored row is drawn
//     (style.css .nx-rc).
// The legend and the switch are components, in RowColors.jsx.
import { createContext, createElement, useCallback, useContext, useMemo } from 'react';
import { todayISO } from './lib';
import { colorMap, usableRules } from './colorRules';
import { useTableValue } from './tableCols';
import { useTasks } from './TasksContext';

const RowColorsContext = createContext(null);

export function RowColorsProvider({ map, children }) {
  return createElement(RowColorsContext.Provider, { value: map || null }, children);
}

/** The color entry for one task ({ id, name, color, hex, bold }) or null. */
export function useRowColor(taskId) {
  const map = useContext(RowColorsContext);
  return (map && taskId && map.get(taskId)) || null;
}

/** The whole taskId -> color map (or null outside a provider), for a view
 *  that draws its rows in a loop rather than as components. */
export function useRowColorMap() {
  return useContext(RowColorsContext);
}

/** className / style for a colored row. `card` = an inset accent that clears
 *  rounded corners and no tint (board cards). The caller keeps its own
 *  data-selected; the CSS drops the tint from a selected row. */
export function rowColorAttrs(entry, { card = false } = {}) {
  if (!entry) return { className: '', style: null };
  return { className: card ? 'nx-rc nx-rc-card' : 'nx-rc nx-rc-tint', style: { '--rc': entry.hex } };
}

/** Text for screen readers only - a row's color is also said in words. */
export const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

/** The title style a "Bold Title" rule asks for (inside an .nx-rc element):
 *  bold, in the deep shade of the rule's color - a finished task keeps its
 *  quiet color. */
export const boldTitleStyle = (entry, completed = false) => (entry?.bold
  ? { fontWeight: 700, ...(completed ? null : { color: 'var(--rc-ink)' }) }
  : null);

// The person's settings - one document in their profile for every screen:
// { hidden: true } turns colors off, { legendClosed: true } folds the key,
// { mine: [rules] } are their own rules for My Tasks. `patch` returns the
// save, so the editor can say when one did not land.
export function useRowColorPrefs() {
  const [data, setData] = useTableValue('rowColors', 'data', null);
  const prefs = data && typeof data === 'object' ? data : {};
  const patch = useCallback((p) => setData((cur) => ({ ...(cur && typeof cur === 'object' ? cur : {}), ...p })), [setData]);
  return [prefs, patch];
}

/** What the evaluator and the editor read about this scope, memoized: every
 *  custom field by id (a field a rule uses may no longer be a column here and
 *  still has to resolve), status labels and the statuses offered, the
 *  sections (Custom grouping) and how a task's is found, and who "me" is.
 *  `projectId` '' = the person's own list. */
export function useRuleContext({ projectId = '', sections = null, sectionOf = null } = {}) {
  const { customFields, statusMeta, statusOrderFor, statusOrder: allStatuses, myEmail, nameOf } = useTasks();
  const statusOrder = useMemo(() => (statusOrderFor ? statusOrderFor(projectId) : allStatuses) || [],
    [statusOrderFor, projectId, allStatuses]);
  return useMemo(() => ({
    fieldsById: new Map((customFields || []).map((f) => [f.id, f])),
    statusMeta: statusMeta || {},
    statusOrder,
    statusOptions: statusOrder.map((id) => ({ id, label: statusMeta?.[id]?.label || id, color: statusMeta?.[id]?.color })),
    sections, sectionOf,
    me: String(myEmail || '').toLowerCase(),
    nameOf,
  }), [customFields, statusMeta, statusOrder, sections, sectionOf, myEmail, nameOf]);
}

/**
 * One screen's row colors.
 *   rules   - the rules in force (a project's, or the person's own)
 *   tasks   - the tasks on screen (the map covers only these)
 *   ruleCtx - from useRuleContext
 */
export function useRowColorScope({ rules, tasks, ruleCtx }) {
  const [prefs, patchPrefs] = useRowColorPrefs();
  const show = !prefs.hidden;
  // A day string, so the map refreshes when the date turns over and "due
  // today" moves on with it - nothing finer about the clock matters.
  const today = todayISO();
  const usable = useMemo(() => usableRules(rules, ruleCtx), [rules, ruleCtx]);
  const map = useMemo(() => (show && usable.length
    ? colorMap(usable, tasks, { ...ruleCtx, today })
    : new Map()), [show, usable, tasks, ruleCtx, today]);
  return {
    show, map, usable,
    setShow: (on) => patchPrefs({ hidden: !on }),
    legendOpen: !prefs.legendClosed,
    setLegendOpen: (open) => patchPrefs({ legendClosed: !open }),
  };
}
