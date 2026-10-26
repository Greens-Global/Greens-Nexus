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
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { todayISO } from './lib';
import { colorMapWith, compileRules, sanitizeRules, usableRules } from './colorRules';
import { useTableValue } from './tableCols';
import { useTasks } from './TasksContext';
import { NX } from './theme';

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

/** A due-date color as it should read on a tinted row: the overdue red and
 *  the due-today amber become the deeper shades the tint keeps at 4.5:1
 *  (style.css --rc-overdue / --rc-due-today). Anything else, or an uncolored
 *  row, is left as it is. */
export function onTint(color, entry) {
  if (!entry) return color;
  if (color === NX.red) return 'var(--rc-overdue)';
  if (color === NX.amber) return 'var(--rc-due-today)';
  return color;
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
  const prefs = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const patch = useCallback((p) => setData((cur) => ({ ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), ...p })), [setData]);
  return [prefs, patch];
}

/** The person's own rules (My Tasks), read defensively - a malformed document
 *  drops the bad rules, never the screen - and how to save them. A save the
 *  server refuses puts the previous rules back (in this browser and in the
 *  profile) and rejects, so the editor can say why. */
export function useMyColorRules() {
  const [prefs, patch] = useRowColorPrefs();
  const raw = prefs.mine;
  const rules = useMemo(() => sanitizeRules(raw), [raw]);
  const save = useCallback(async (next) => {
    const before = raw;
    try {
      await patch({ mine: next });
    } catch (e) {
      Promise.resolve(patch({ mine: Array.isArray(before) ? before : [] })).catch(() => {});
      throw e;
    }
  }, [patch, raw]);
  return [rules, save];
}

/** Today's LOCAL date as a string that changes when the day does: at local
 *  midnight (a timer), and whenever the tab comes back into view or focus
 *  (a timer does not run in a sleeping laptop). "Overdue" flips on its own. */
export function useToday() {
  const [today, setToday] = useState(todayISO);
  useEffect(() => {
    const check = () => setToday((cur) => { const now = todayISO(); return now === cur ? cur : now; });
    let timer;
    const arm = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
      timer = setTimeout(() => { check(); arm(); }, Math.max(1000, next - now));
    };
    arm();
    const onVisible = () => { if (document.visibilityState !== 'hidden') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, []);
  return today;
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
  const today = useToday();
  const clean = useMemo(() => sanitizeRules(rules), [rules]);
  const usable = useMemo(() => usableRules(clean, ruleCtx), [clean, ruleCtx]);
  // Compiled once per (rules, context, day); its per-task cache then carries
  // across every re-render that only changes WHICH tasks are on screen.
  const compiled = useMemo(() => compileRules(usable, { ...ruleCtx, today }), [usable, ruleCtx, today]);
  const map = useMemo(() => (show && usable.length ? colorMapWith(compiled, tasks) : new Map()),
    [show, usable.length, compiled, tasks]);
  return {
    show, map, usable, today,
    setShow: (on) => patchPrefs({ hidden: !on }),
    legendOpen: !prefs.legendClosed,
    setLegendOpen: (open) => patchPrefs({ legendClosed: !open }),
  };
}
