import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_RULES, MAX_VIEWS, MAX_WIDTH, MIN_WIDTH, applyView, arrange, canMove, defaultState, distinctValues,
  filterCount, kindOf, moveColumn, normalizeState, opsFor, ruleId, sameState,
} from './model';

// One table's view, kept per person (10/23 meeting, item 01; Viral 09:21: "As
// per your personal preference ... we won't need to memorize it").
//
// Where it lives: the person's own Accounting layout (accounting_user_prefs,
// GET / PUT /accounting/prefs - only ever the caller's row), key `tableViews`:
//   { [tableKey]: { active: viewId | '', list: [{ id, name, state }], draft: state? } }
// so the views follow the person to any computer and survive a refresh and a
// sign-out. `draft` is the working state while it differs from the view
// picked - the "Unsaved" mark - and is kept too, so nothing set up is lost on
// a refresh; Update writes it into the view, Clear drops it.
//
//   const view = useTableView('records-gl-accounts', COLUMNS, rows, { sort: { col: 'account', dir: 'asc' } });
//   view.rows      the rows the view leaves, in its order (totals, paging and export use these)
//   view.columns   the columns shown, in order, each with its width
//   <TableViewBar view={view} />   <ViewHead view={view} col={c} />   (./controls)
// `onOpen(kind)`: called when one of its panels or menus opens (a screen that
// pages on the server reads every row then, so a value list is complete).
//
// `columns` should be memoized by the screen (useMemo / a module constant).
// Each column: see ./model (key, label, type, text, value, width, off, fixed, total).

const SAVE_MS = 400;

// `store` is [prefs, setPrefs] of the person's Accounting layout (../prefs);
// index.js hands it in, so this folder imports nothing of the screens.
export function useTableViewWith(store, tableKey, baseColumns, rows, { sort = null, onOpen = null } = {}) {
  const [prefs, setPrefs] = store;
  // Widths a person dragged before views existed (useColumnWidths, same table
  // key) are their default widths, so nobody loses a layout.
  const legacy = prefs.colWidths && typeof prefs.colWidths === 'object' ? prefs.colWidths[tableKey] : null;
  const columns = useMemo(() => (legacy && typeof legacy === 'object'
    ? baseColumns.map((c) => (Number(legacy[c.key]) > 0 ? { ...c, width: Number(legacy[c.key]) } : c))
    : baseColumns), [baseColumns, legacy]);
  const entry = prefs.tableViews && typeof prefs.tableViews === 'object' ? prefs.tableViews[tableKey] || {} : {};
  const list = useMemo(() => (Array.isArray(entry.list) ? entry.list.filter((v) => v && v.id && v.name) : []), [entry.list]);
  const activeId = list.some((v) => v.id === entry.active) ? entry.active : '';
  const sortKey = sort ? `${sort.col}|${sort.dir}` : '';
  const base = useMemo(() => defaultState({ sort }), [sortKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useMemo(() => (activeId ? normalizeState(list.find((v) => v.id === activeId).state, base) : base), [activeId, list, base]);
  const stored = useMemo(() => (entry.draft ? normalizeState(entry.draft, saved) : saved), [entry.draft, saved]);
  // The working state while a change waits to be written (typing in a rule).
  const [local, setLocal] = useState(null);
  const state = local || stored;
  // The latest state for the actions (two changes in one event see each other).
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);

  // Every write goes through the shared prefs with the CURRENT copy, so two
  // tables (or two quick changes) never undo each other.
  const write = useCallback((fn) => {
    setPrefs((cur) => {
      const all = { ...(cur.tableViews && typeof cur.tableViews === 'object' ? cur.tableViews : {}) };
      const e = { ...(all[tableKey] || {}) };
      e.list = Array.isArray(e.list) ? e.list : [];
      fn(e);
      if (!e.list.length) delete e.list;
      if (!e.active) delete e.active;
      if (Object.keys(e).length) all[tableKey] = e; else delete all[tableKey];
      return { tableViews: all };
    });
  }, [setPrefs, tableKey]);
  const savedOf = useCallback((e) => {
    const v = (e.list || []).find((x) => x.id === e.active);
    return v ? normalizeState(v.state, base) : base;
  }, [base]);

  const timer = useRef(null);
  const pending = useRef(null);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    write((e) => { if (sameState(next, savedOf(e))) delete e.draft; else e.draft = next; });
    setLocal(null);
  }, [write, savedOf]);
  const drop = () => { clearTimeout(timer.current); timer.current = null; pending.current = null; setLocal(null); };
  useEffect(() => () => { if (pending.current) flush(); }, [flush]);

  /** Change the working state: a patch object or a function of the state. */
  const setState = useCallback((patch) => {
    const cur = stateRef.current;
    const next = normalizeState(typeof patch === 'function' ? patch(cur) : { ...cur, ...patch });
    stateRef.current = next;
    setLocal(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_MS);
  }, [flush]);

  // A column being dragged wider: drawn live, saved on release.
  const [live, setLive] = useState(null);
  const liveRef = useRef(null);

  const arranged = useMemo(() => arrange(columns, state), [columns, state]);
  const shown = useMemo(
    () => arranged.filter((c) => !c.hidden).map((c) => (live && live.key === c.key ? { ...c, width: live.w } : c)),
    [arranged, live],
  );
  const out = useMemo(() => applyView(rows || [], columns, state), [rows, columns, state]);
  const dirty = !sameState(state, saved);
  const count = filterCount(state, columns);
  const clamp = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(w) || 0)));

  const actions = {
    setState,
    /** Switch to a saved view ('' = the built-in default). */
    select: (id) => { drop(); write((e) => { e.active = id || ''; delete e.draft; }); },
    /** Save the working state as a new view (a name already used is replaced). */
    saveAs: (name) => {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) return '';
      const next = stateRef.current;
      const same = list.find((v) => v.name.toLowerCase() === clean.toLowerCase());
      const id = same ? same.id : `v${Date.now().toString(36)}`;
      drop();
      write((e) => {
        const rest = e.list.filter((v) => v.id !== id);
        e.list = [...rest, { id, name: clean, state: next }].slice(-MAX_VIEWS);
        e.active = id;
        delete e.draft;
      });
      return id;
    },
    /** Write the working state into the view picked (the built-in default cannot change). */
    update: () => {
      if (!activeId) return false;
      const next = stateRef.current;
      drop();
      write((e) => { e.list = e.list.map((v) => (v.id === activeId ? { ...v, state: next } : v)); delete e.draft; });
      return true;
    },
    rename: (id, name) => {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) return;
      write((e) => { e.list = e.list.map((v) => (v.id === id ? { ...v, name: clean } : v)); });
    },
    remove: (id) => {
      if (id === activeId) drop();
      write((e) => { e.list = e.list.filter((v) => v.id !== id); if (e.active === id) { e.active = ''; delete e.draft; } });
    },
    /** Back to the view's saved filters, sort and columns. */
    clear: () => { drop(); write((e) => { delete e.draft; }); },

    sortBy: (key, dir) => setState({ sort: dir ? { col: key, dir } : null }),
    setWidth: (key, w) => setState((s) => {
      const widths = { ...s.widths };
      if (w) widths[key] = clamp(w); else delete widths[key];
      return { ...s, widths };
    }),
    /** For <ColumnResizer />: drag live, save on release, double-click fits. */
    resizer: (key, name) => ({
      label: `Resize the ${name || key} column`,
      onDrag: (w) => { liveRef.current = { key, w: clamp(w) }; setLive(liveRef.current); },
      onEnd: () => {
        const l = liveRef.current;
        liveRef.current = null;
        setLive(null);
        if (l) actions.setWidth(l.key, l.w);
      },
      onFit: (w) => actions.setWidth(key, w > 0 ? w : null),
    }),
    move: (key, dir) => setState((s) => ({ ...s, order: moveColumn(columns, s, key, dir) })),
    canMove: (key, dir) => canMove(columns, state, key, dir),
    show: (key, on) => setState((s) => {
      const vis = { ...s.vis };
      const col = columns.find((c) => c.key === key);
      if (!col || col.fixed) return s;
      if (on === !col.off) delete vis[key]; else vis[key] = !!on;
      // Keep one column on screen at least.
      const left = arrange(columns, { ...s, vis }).filter((c) => !c.hidden).length;
      return left ? { ...s, vis } : s;
    }),
    /** Columns shown / hidden back to the screen's default. */
    resetColumns: () => setState((s) => ({ ...s, vis: {}, order: [], widths: {} })),

    /** A new rule (for one column, or the first that filters); returns its id. */
    addRule: (key) => {
      const s = stateRef.current;
      if (s.rules.length >= MAX_RULES) return '';
      const col = columns.find((c) => c.key === key && !c.noFilter) || columns.find((c) => !c.noFilter);
      if (!col) return '';
      const id = ruleId();
      setState({ rules: [...s.rules, { id, col: col.key, op: opsFor(col)[0].key, a: '', b: '' }] });
      return id;
    },
    setRule: (id, patch) => setState((s) => ({
      ...s,
      rules: s.rules.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        // A new column brings its own conditions (a date has no "Contains"):
        // another kind of column starts from its first one.
        if (patch.col && patch.col !== r.col) {
          const col = columns.find((c) => c.key === patch.col);
          const was = columns.find((c) => c.key === r.col);
          const ops = col ? opsFor(col) : [];
          if (!was || kindOf(was) !== kindOf(col) || !ops.some((o) => o.key === next.op)) next.op = ops[0]?.key || '';
          next.a = '';
          next.b = '';
        }
        return next;
      }),
    })),
    removeRule: (id) => setState((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) })),
    setMatch: (match) => setState({ match: match === 'any' ? 'any' : 'all' }),
    /** A heading's value list: { in: [...] } | { out: [...] } | null (no filter). */
    setPick: (key, pick) => setState((s) => {
      const picks = { ...s.picks };
      if (pick) picks[key] = pick; else delete picks[key];
      return { ...s, picks };
    }),
    /** Every filter off (rules and value lists), the layout kept. */
    clearFilters: () => setState((s) => ({ ...s, rules: [], picks: {} })),
  };

  return {
    key: tableKey,
    onOpen,
    rows: out,
    all: rows || [],
    columns: shown,
    arranged,
    allColumns: columns,
    state,
    dirty,
    count,
    views: list.map(({ id, name }) => ({ id, name })),
    activeId,
    activeName: activeId ? list.find((v) => v.id === activeId).name : 'Built-in Default',
    sortOf: (key) => (state.sort?.col === key ? state.sort.dir : null),
    picked: (key) => !!state.picks[key],
    filtered: (key) => !!state.picks[key] || state.rules.some((r) => r.col === key),
    distinct: (key) => distinctValues(rows || [], columns, state, key),
    width: (key) => (live?.key === key ? live.w : shown.find((c) => c.key === key)?.width),
    /** A width the person set (dragged or typed), else undefined - for tables that size to their content. */
    manualWidth: (key) => (live?.key === key ? live.w : state.widths[key]),
    ...actions,
  };
}
