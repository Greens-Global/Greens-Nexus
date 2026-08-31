// Task Module - shared column kit for the tabular views.
//
// Every list here (My Tasks, the Task List, Projects, Portfolios) wants the
// same three behaviors, and each had grown its own partial answer: the Task
// List could resize and sort, My Tasks could only sort, Projects and
// Portfolios could do neither and hardcoded their grid template in three
// places. This is the one implementation they all use.
//
//   * drag a header's right edge to resize that column
//   * drag a header itself to move the column
//   * click a header to sort by it: unsorted -> ascending -> descending -> back
//
// Order and widths live in the USER'S PROFILE (`/task-prefs`, one row per
// person), not in this browser - someone who arranges their Task List at their
// desk finds the same arrangement on a laptop. localStorage is kept as a cache
// so the table paints its arranged shape immediately instead of laying out in
// default order and then jumping when the fetch lands.
//
// Nothing here can leave a list unusable: every server call falls back to the
// default columns, so a failed save costs the arrangement, never the screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { NX } from './theme';

const MIN_W = 60;
// Breathing room either side of the widest cell, and a ceiling: one pathological
// title should not push a column past half the screen and shove every other
// column out of reach.
const AUTOFIT_PAD = 16;
const AUTOFIT_MAX_W = 640;
const CACHE_KEY = 'nexus.taskTablePrefs';

// ── The user's saved arrangement, shared by every table on screen ───────────
// Four lists can be mounted at once; they read one document and one fetch.
let cache = null;             // { table: { order: [], widths: {} } }
let inflight = null;
const listeners = new Set();

const readCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
};
const writeCache = (prefs) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
};
const emit = () => listeners.forEach((fn) => fn(cache));

// One per-table bag holds two unrelated kinds of thing, and only the first is
// what "Reset Columns" is about:
//   COLUMN_KEYS  - how the columns are arranged (order, widths, hidden)
//   the rest     - where the person left the screen (view, group, sort,
//                  collapsed sections), which a column reset must not touch
// Counting the whole bag made the button appear the moment someone switched to
// the grid or sorted a header, offering to restore an arrangement they had
// never made.
const COLUMN_KEYS = ['order', 'widths', 'hidden'];
const isSet = (v) => (Array.isArray(v) ? v.length > 0 : !!v && typeof v === 'object' && Object.keys(v).length > 0);
const hasColumnPrefs = (all) => Object.values(all || {}).some((t) => COLUMN_KEYS.some((k) => isSet(t?.[k])));

function loadPrefs() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.getTaskTablePrefs()
      .then((r) => { cache = r?.prefs || {}; writeCache(cache); emit(); return cache; })
      // Offline or a 500: fall back to whatever this browser last saw, then to
      // the defaults. A person who cannot reach the server still gets a table.
      .catch(() => { cache = readCache() || {}; emit(); return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Optimistic: the arrangement is applied locally and then sent. A failed PUT
// leaves what the user sees in place rather than snapping their drag back -
// the next load re-reads the server and settles the difference.
function patchTable(table, patch) {
  cache = { ...(cache || {}), [table]: { ...((cache || {})[table] || {}), ...patch } };
  writeCache(cache);
  emit();
  api.saveTaskTablePrefs(table, patch).catch(() => {});
}

function clearTable(table) {
  const next = { ...(cache || {}) };
  delete next[table];
  cache = next;
  writeCache(cache);
  emit();
  api.resetTaskTablePrefs(table).catch(() => {});
}

/** Put every list in the module back to its default columns - and ONLY its
 *  columns. The view, grouping, sort and collapsed sections share this document
 *  but are not what the button offers to restore; wiping them sent someone who
 *  straightened one column back to the default view on every screen at once.
 *
 *  The server holds one document per person with no partial delete, so this
 *  drops it and puts the non-column half straight back. A failed restore costs
 *  the remembered view, never the reset the person asked for. */
export function resetAllTablePrefs() {
  const keep = {};
  for (const [table, prefs] of Object.entries(cache || {})) {
    const rest = Object.fromEntries(Object.entries(prefs || {}).filter(([k]) => !COLUMN_KEYS.includes(k)));
    if (Object.keys(rest).length) keep[table] = rest;
  }
  cache = keep;
  writeCache(cache);
  emit();
  return api.resetAllTaskTablePrefs()
    .then(() => Promise.all(Object.entries(keep).map(([table, prefs]) => api.saveTaskTablePrefs(table, prefs))))
    .catch(() => {});
}

// Test seam: lets a test start from a known document without a server.
export function __setTablePrefsCache(next) {
  cache = next;
  emit();
}

/** True once this person has arranged the COLUMNS of any table - moved one,
 *  resized one, hidden one. Drives the reset control, which is clutter above a
 *  list nobody has customized, and a puzzle above one where all they did was
 *  switch to the grid. */
export function useHasTablePrefs() {
  const [has, setHas] = useState(() => hasColumnPrefs(cache || readCache()));
  useEffect(() => {
    const fn = (all) => setHas(hasColumnPrefs(all));
    listeners.add(fn);
    // Read the CURRENT cache when the load settles, not the snapshot the
    // promise captured: an in-flight load that lands after a reset would
    // otherwise put the stale document straight back on screen.
    loadPrefs().then(() => fn(cache));
    return () => listeners.delete(fn);
  }, []);
  return has;
}

function useTablePrefs(table) {
  const [prefs, setPrefs] = useState(() => (cache || readCache() || {})[table] || {});
  useEffect(() => {
    const fn = (all) => setPrefs((all || {})[table] || {});
    listeners.add(fn);
    loadPrefs().then(() => fn(cache));   // current cache, not the captured one
    return () => listeners.delete(fn);
  }, [table]);
  return prefs;
}

/** A single list-valued setting for one table, stored in the user's profile
 *  alongside its column order and widths - hidden columns, collapsed groups.
 *
 *  `fallback` applies only when the key has NEVER been set. An empty array is a
 *  real, stored value, which is what lets someone re-open a section that ships
 *  collapsed by default and have it stay open. */
export function useTableSetting(table, name, fallback) {
  const prefs = useTablePrefs(table);
  const stored = prefs[name];
  const value = useMemo(() => (Array.isArray(stored) ? stored : fallback), [stored, fallback]);
  const set = useCallback((next) => {
    const list = next instanceof Set ? [...next] : next;
    patchTable(table, { [name]: list });
  }, [table, name]);
  return [value, set];
}

/** A single scalar/object setting for one table, stored in the user's profile:
 *  the view they were on, what they grouped by, how they sorted. Supports a
 *  functional updater, since `setSort` is called that way. */
export function useTableValue(table, name, fallback) {
  const prefs = useTablePrefs(table);
  const stored = prefs[name];
  const value = stored === undefined ? fallback : stored;
  const ref = useRef(value);
  ref.current = value;
  const set = useCallback((next) => {
    patchTable(table, { [name]: typeof next === 'function' ? next(ref.current) : next });
  }, [table, name]);
  return [value, set];
}

// ── Ordering ────────────────────────────────────────────────────────────────
/** Apply a saved order to the default columns.
 *
 *  Columns marked `fixed` never move (the Task List's checkbox and the trailing
 *  actions cell are structure, not data). A saved key that no longer exists is
 *  ignored, and a column that did not exist when the order was saved lands
 *  after the arranged ones - both mean a shipped column change degrades to a
 *  slightly-off order rather than a broken table. */
export function applyOrder(cols, order) {
  if (!order?.length) return cols;
  const movable = cols.filter((c) => !c.fixed);
  const byKey = new Map(movable.map((c) => [c.key, c]));
  const arranged = order.map((k) => byKey.get(k)).filter(Boolean);
  const placed = new Set(arranged.map((c) => c.key));
  const seq = [...arranged, ...movable.filter((c) => !placed.has(c.key))];
  let i = 0;
  return cols.map((c) => (c.fixed ? c : seq[i++]));
}

// ── The hook ────────────────────────────────────────────────────────────────
/** `table` is this list's id in the saved document ("richlist", "mytasks", …).
 *  `cols` is the ordered list of VISIBLE default columns, each `{ key, width }`
 *  (or `template` for an elastic one, `fixed` to pin it). `trailing` is
 *  appended verbatim for tables that render a gutter cell. */
export function useTableColumns({ table, cols, trailing = '' }) {
  const saved = useTablePrefs(table);
  const orderedCols = useMemo(() => applyOrder(cols, saved.order), [cols, saved.order]);
  const widths = useMemo(() => saved.widths || {}, [saved.widths]);

  const wrapRef = useRef(null);
  // Refs, not deps: startResize has to see the CURRENT columns and widths
  // without being rebuilt on every render (it is handed to every header cell).
  const colsRef = useRef(orderedCols);
  colsRef.current = orderedCols;
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const templateFrom = useCallback((wd) => {
    const parts = colsRef.current.map((c) => {
      const w = wd[c.key];
      if (w) return `${w}px`;
      return c.template || (c.width ? `${c.width}px` : 'minmax(0,1fr)');
    });
    if (trailing) parts.push(trailing);
    return parts.join(' ');
  }, [trailing]);

  const template = templateFrom(widths);

  // During the drag the new template is written straight to the wrapper's CSS
  // variable. The header and every row read var(--nx-grid), so the browser
  // reflows the grid with ZERO React re-renders - that is what keeps a resize
  // smooth with a hundred rows on screen. State is saved once, on release.
  // Second press on the same edge inside this window = autofit. Held in a ref
  // on the hook, which survives a re-render, because the handle's DOM node does
  // not: a table whose header is an inline component (views/richlist.jsx) tears
  // the whole header down and rebuilds it on any render, and the browser only
  // raises `dblclick` when both clicks land on the SAME node.
  const lastPress = useRef({ key: null, at: 0 });
  const DOUBLE_MS = 400;

  const startResize = useCallback((key, startWidth) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (lastPress.current.key === key && now - lastPress.current.at < DOUBLE_MS) {
      lastPress.current = { key: null, at: 0 };
      autofitRef.current?.(key);
      return;   // a double-click is not the start of a drag
    }
    lastPress.current = { key, at: now };
    const startX = e.clientX;
    let latest = startWidth, raf = 0, moved = false;
    const apply = () => {
      raf = 0;
      const el = wrapRef.current;
      if (el) el.style.setProperty('--nx-grid', templateFrom({ ...widthsRef.current, [key]: latest }));
    };
    const onMove = (ev) => {
      const next = Math.max(MIN_W, startWidth + (ev.clientX - startX));
      if (next === latest) return;
      latest = next;
      moved = true;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = '';
      // A press that never moved is not a resize. Writing the unchanged width
      // anyway pinned columns nobody had touched, and - because saving
      // re-renders - it was what replaced this very handle between the two
      // clicks of a double-click.
      if (moved) patchTable(table, { widths: { ...widthsRef.current, [key]: latest } });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [templateFrom, table]);

  /** Size a column to the widest thing in it, the way double-clicking a column
   *  edge does in a spreadsheet.
   *
   *  Measured by asking the browser rather than by guessing from string
   *  lengths: the column is set to `max-content` for one synchronous layout,
   *  every rendered cell in it is read, and the template is put straight back.
   *  Nothing repaints in between - the write, the reads and the restore all
   *  happen before the frame is committed - so there is no flicker.
   *
   *  Each row is its OWN grid sharing one template, so under max-content each
   *  resolves to its own content width and the widest of them is the answer.
   *  The header row is measured too, so autofitting can never clip the label.
   *
   *  Only rendered rows can be measured, and this list hands rows out from a
   *  budget that grows as you scroll (views/richlist.jsx), so on a long list
   *  this fits what has been rendered rather than all 2,400 rows. That is the
   *  usual spreadsheet behavior too, and the alternative - laying out every row
   *  off-screen to measure it - is exactly the freeze that budget exists to
   *  prevent. */
  // Set below, once autofitWidth exists - startResize is declared first and
  // needs to call it without taking it as a dependency.
  const autofitRef = useRef(null);

  const autofitWidth = useCallback((key) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const idx = colsRef.current.findIndex((c) => c.key === key);
    if (idx < 0) return;
    const widthOf = (c) => {
      const w = widthsRef.current[c.key];
      if (w) return `${w}px`;
      return c.template || (c.width ? `${c.width}px` : 'minmax(0,1fr)');
    };
    const probe = colsRef.current.map((c, i) => (i === idx ? 'max-content' : widthOf(c)));
    if (trailing) probe.push(trailing);

    const before = wrap.style.getPropertyValue('--nx-grid');
    wrap.style.setProperty('--nx-grid', probe.join(' '));
    // Every grid that follows the template carries it in its inline style, so
    // this finds the header and the rows without each table having to tag them.
    let widest = 0;
    for (const row of wrap.querySelectorAll('[style*="var(--nx-grid)"]')) {
      const cell = row.children[idx];
      if (cell) widest = Math.max(widest, cell.getBoundingClientRect().width);
    }
    wrap.style.setProperty('--nx-grid', before);

    if (!widest) return;   // nothing rendered in that column - leave it alone
    const next = Math.round(Math.min(Math.max(widest + AUTOFIT_PAD, MIN_W), AUTOFIT_MAX_W));
    patchTable(table, { widths: { ...widthsRef.current, [key]: next } });
  }, [table, trailing]);
  autofitRef.current = autofitWidth;

  const resetWidth = useCallback((key) => {
    const next = { ...widthsRef.current };
    delete next[key];
    patchTable(table, { widths: next });
  }, [table]);

  // ── Drag to reorder ──────────────────────────────────────────────────────
  const [dragKey, setDragKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);

  const moveColumn = useCallback((from, to) => {
    if (!from || !to || from === to) return;
    const movable = colsRef.current.filter((c) => !c.fixed).map((c) => c.key);
    const fi = movable.indexOf(from), ti = movable.indexOf(to);
    if (fi < 0 || ti < 0) return;
    movable.splice(ti, 0, ...movable.splice(fi, 1));
    patchTable(table, { order: movable });
  }, [table]);

  /** Spread onto a header cell to make that column draggable. */
  const dragProps = useCallback((key, movable = true) => {
    if (!movable) return undefined;
    return {
      draggable: true,
      onDragStart: (e) => {
        // Some browsers refuse to start a drag without data on the transfer.
        try { e.dataTransfer.setData('text/plain', key); } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move';
        setDragKey(key);
      },
      onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(key); },
      onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
      onDrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        moveColumn(dragKey, key);
        setDragKey(null); setDropKey(null);
      },
      onDragEnd: () => { setDragKey(null); setDropKey(null); },
      'data-dragging': dragKey === key || undefined,
      'data-dropping': (dropKey === key && dragKey && dragKey !== key) || undefined,
    };
  }, [dragKey, dropKey, moveColumn]);

  const resetTable = useCallback(() => clearTable(table), [table]);

  return { cols: orderedCols, widths, template, startResize, resetWidth, autofitWidth, wrapRef, dragProps, resetTable, dragKey };
}

// ── Sorting ─────────────────────────────────────────────────────────────────
// unsorted -> asc -> desc -> `reset`. Getting back to the unsorted order from
// the same control that left it matters: in the Task List that order is the one
// row drag-reorder works under, and everywhere else it is the "however this
// list normally reads" default.
export function nextSort(prev, key, reset = null) {
  if (prev?.key !== key) return { key, dir: 'asc' };
  if (prev.dir === 'asc') return { key, dir: 'desc' };
  return reset;
}

// ── Header pieces ───────────────────────────────────────────────────────────
/** The drag handle on a header cell's right edge. */
export function ColResizer({ onMouseDown, onReset, onAutofit }) {
  const [hover, setHover] = useState(false);
  return (
    <div onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); (onAutofit || onReset)?.(); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      draggable={false} onDragStart={(e) => e.preventDefault()}
      title={onAutofit ? 'Drag to resize, double-click to fit the content' : 'Drag to resize, double-click to reset'}
      style={{
        position: 'absolute', top: 0, right: -6, bottom: 0, width: 12, zIndex: 2,
        cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      <span style={{ height: '60%', width: 1, background: hover ? NX.blue : NX.border }} />
    </div>
  );
}

/** One header cell: the label, the sort arrow when it is the active sort, the
 *  resize handle, and (when `drag` is spread in) drag-to-reorder. Callers pass
 *  their own `style` so each table keeps its own header typography while the
 *  behavior stays identical. */
export function TableHead({
  label, sortKey, sort, setSort, sortReset = null,
  onResizeStart, onResizeReset, onResizeAutofit, align = 'flex-start', style, title, drag,
}) {
  const [hover, setHover] = useState(false);
  const active = sortKey && sort?.key === sortKey;
  const Arrow = sort?.dir === 'desc' ? ArrowDown : ArrowUp;
  const click = sortKey && setSort ? () => setSort((prev) => nextSort(prev, sortKey, sortReset)) : undefined;
  const draggable = !!drag?.draggable;
  return (
    <div {...drag} onClick={click}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title={title || (sortKey ? `Sort by ${label}` : undefined)}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: 3,
        justifyContent: align, minWidth: 0, userSelect: 'none',
        cursor: click ? 'pointer' : draggable ? 'grab' : 'default',
        color: active ? NX.ink : undefined,
        // The column being dragged fades; the one it would land on shows the
        // insertion edge, so a drop reads as "it goes there" before releasing.
        opacity: drag?.['data-dragging'] ? 0.4 : 1,
        boxShadow: drag?.['data-dropping'] ? `inset 2px 0 0 ${NX.blue}` : 'none',
        ...style,
      }}>
      {/* The grip only appears on hover - a permanent one on every header is a
          row of clutter above a list people mostly just read. */}
      {draggable && label ? (
        <GripVertical size={11} style={{ flexShrink: 0, color: NX.faint, opacity: hover ? 1 : 0, transition: 'opacity 0.12s' }} />
      ) : null}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {active && <Arrow size={12} strokeWidth={2.5} style={{ flexShrink: 0, color: NX.primary }} />}
      {onResizeStart && <ColResizer onMouseDown={onResizeStart} onReset={onResizeReset} onAutofit={onResizeAutofit} />}
    </div>
  );
}

/** "Restore Default Columns" - puts the order and widths of EVERY list in the
 *  module back to their defaults. Renders nothing until the person has actually
 *  changed something, so it is an escape hatch rather than a permanent control.
 *  `variant: 'menu'` renders it as a row inside an open menu instead. */
export function ResetColumnsButton({ variant = 'button', style }) {
  const has = useHasTablePrefs();
  if (!has) return null;
  const click = () => resetAllTablePrefs();
  if (variant === 'menu') {
    return (
      <button onClick={click} style={{
        display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 8px',
        border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer',
        fontSize: 12.5, fontWeight: 600, color: NX.dim, textAlign: 'left', ...style,
      }}
        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
        <RotateCcw size={13} />Restore Default Columns
      </button>
    );
  }
  return (
    <button onClick={click} title="Put every list's column order and widths back to their defaults"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px',
        border: `1px solid ${NX.border}`, background: 'transparent', borderRadius: 8,
        cursor: 'pointer', fontSize: 12, fontWeight: 600, color: NX.dim, flexShrink: 0, ...style,
      }}>
      <RotateCcw size={12} />Reset Columns
    </button>
  );
}
