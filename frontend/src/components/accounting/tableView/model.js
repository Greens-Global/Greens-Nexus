import { parseFigure } from '../reportModel';

// The standard table view of every Accounting table (10/23 meeting, item 01).
// Viral showed his own app (06:05-09:52): "instead of that, can we do filters
// here similar to Excel table?" - rule filters (field + condition + value, up
// to 20, All or Any), an Excel-style value list on each heading, a column menu
// (sort, filter this column, manual width, move left / right, show hidden),
// saved views per person with an "Unsaved" mark and Update, Clear, and totals
// that follow the filter. Neil, 18:24: "the same filters ... should basically
// be on every single accounting tab".
//
// This file is the pure part: what a view holds and what it leaves of a list.
// useTableView (./useTableView) keeps it per person; ./controls draws the bar
// and the headings; ./panels (loaded on first use) the panels and menus.
//
// A COLUMN, as each screen describes it:
//   key      unique in the table
//   label    the heading (Title Case)
//   type     'text' (default) | 'number' | 'amount' | 'date'
//   text(r)  what the cell reads - the value lists and text rules use it
//   value(r) the raw value for numbers, amounts and dates (a date as
//            YYYY-MM-DD); defaults to text(r)
//   width    the default width in px
//   off      hidden until the person shows it
//   fixed    stays where it is: never moved or hidden (a pinned first column)
//   total    an amount the totals row and the export add up
//   sortBy(r) what the column sorts on, when not what it shows
//   exportAs [{ label, num, width, total, get(r) }] the column in an export
//   noFilter / noSort   the column takes no filter / no sort (an action column)
//
// A VIEW'S STATE (what a saved view keeps):
//   rules   [{ id, col, op, a, b }]   the Filters panel's rules
//   match   'all' | 'any'             how the rules combine
//   picks   { [col]: { in: [...] } | { out: [...] } }   the heading value lists
//           (in = only these; out = all but these); they always combine as All
//   sort    { col, dir: 'asc' | 'desc' } | null
//   order   [keys]                    the column order (missing keys keep their place)
//   vis     { [key]: boolean }        shown / hidden where it differs from the default
//   widths  { [key]: px }             manual widths

export const MAX_RULES = 20;
export const MAX_VIEWS = 30;
export const MAX_PICKS = 500;
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 1200;

const none = { none: true };
const two = { two: true };
export const OPS = {
  text: [
    { key: 'contains', label: 'Contains' },
    { key: 'not_contains', label: 'Does Not Contain' },
    { key: 'eq', label: 'Equals' },
    { key: 'ne', label: 'Does Not Equal' },
    { key: 'starts', label: 'Starts With' },
    { key: 'ends', label: 'Ends With' },
    { key: 'empty', label: 'Is Empty', ...none },
    { key: 'not_empty', label: 'Is Not Empty', ...none },
  ],
  number: [
    { key: 'eq', label: 'Equals' },
    { key: 'ne', label: 'Does Not Equal' },
    { key: 'gt', label: 'Greater Than' },
    { key: 'gte', label: 'Greater Than or Equal To' },
    { key: 'lt', label: 'Less Than' },
    { key: 'lte', label: 'Less Than or Equal To' },
    { key: 'between', label: 'Between', ...two },
    { key: 'empty', label: 'Is Empty', ...none },
    { key: 'not_empty', label: 'Is Not Empty', ...none },
  ],
  date: [
    { key: 'eq', label: 'Is On' },
    { key: 'ne', label: 'Is Not On' },
    { key: 'lt', label: 'Is Before' },
    { key: 'gt', label: 'Is After' },
    { key: 'lte', label: 'Is On or Before' },
    { key: 'gte', label: 'Is On or After' },
    { key: 'between', label: 'Is Between', ...two },
    { key: 'empty', label: 'Is Empty', ...none },
    { key: 'not_empty', label: 'Is Not Empty', ...none },
  ],
};

/** 'text' | 'number' | 'date' - which conditions a column takes. */
export const kindOf = (col) => (col?.type === 'amount' || col?.type === 'number' ? 'number' : col?.type === 'date' ? 'date' : 'text');
export const isNumeric = (col) => kindOf(col) === 'number';
export const opsFor = (col) => OPS[kindOf(col)];
export const opOf = (col, key) => opsFor(col).find((o) => o.key === key) || opsFor(col)[0];

/** What a cell reads (the value lists and text rules use it). */
export function textOf(col, row) {
  const v = col.text ? col.text(row) : col.value ? col.value(row) : '';
  return v == null ? '' : String(v);
}
/** A number column's figure (NaN when blank). */
export function numOf(col, row) {
  const v = col.value ? col.value(row) : textOf(col, row);
  if (v == null || v === '') return Number.NaN;
  return typeof v === 'number' ? v : parseFigure(v);
}
/** A date column's day, YYYY-MM-DD ('' when blank). */
export function dayOf(col, row) {
  const v = col.value ? col.value(row) : textOf(col, row);
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

const r2 = (n) => Math.round(n * 100) / 100;
const signed = (t) => /^\s*(-|\()/.test(String(t ?? ''));

/** Whether a rule is complete enough to filter (an empty value filters nothing). */
export function ruleReady(rule, col) {
  if (!rule || !col) return false;
  const op = opOf(col, rule.op);
  if (op.none) return true;
  const kind = kindOf(col);
  const has = (v) => (kind === 'number' ? !Number.isNaN(parseFigure(v)) : kind === 'date' ? !!dayOf({ value: () => v }, null) : String(v ?? '').trim() !== '');
  return op.two ? has(rule.a) || has(rule.b) : has(rule.a);
}

/** Whether one row passes one (complete) rule. */
export function ruleHit(rule, col, row) {
  const op = opOf(col, rule.op).key;
  const kind = kindOf(col);
  if (kind === 'number') {
    const v = numOf(col, row);
    if (op === 'empty') return Number.isNaN(v);
    if (op === 'not_empty') return !Number.isNaN(v);
    if (Number.isNaN(v)) return op === 'ne';
    const a = parseFigure(rule.a);
    const b = parseFigure(rule.b);
    const x = r2(v);
    // An amount typed with no sign matches either sign (a credit prints in
    // parentheses), as the amount boxes under the headings always have.
    const same = (t, n) => (col.type === 'amount' && !signed(t) ? Math.abs(x) === Math.abs(r2(n)) : x === r2(n));
    switch (op) {
      case 'eq': return same(rule.a, a);
      case 'ne': return !same(rule.a, a);
      case 'gt': return x > r2(a);
      case 'gte': return x >= r2(a);
      case 'lt': return x < r2(a);
      case 'lte': return x <= r2(a);
      case 'between': {
        const lo = Number.isNaN(a) ? -Infinity : r2(Number.isNaN(b) ? a : Math.min(a, b));
        const hi = Number.isNaN(b) ? Infinity : r2(Number.isNaN(a) ? b : Math.max(a, b));
        return x >= lo && x <= hi;
      }
      default: return true;
    }
  }
  if (kind === 'date') {
    const d = dayOf(col, row);
    if (op === 'empty') return !d;
    if (op === 'not_empty') return !!d;
    if (!d) return op === 'ne';
    const a = dayOf({ value: () => rule.a }, null);
    const b = dayOf({ value: () => rule.b }, null);
    switch (op) {
      case 'eq': return d === a;
      case 'ne': return d !== a;
      case 'gt': return d > a;
      case 'gte': return d >= a;
      case 'lt': return d < a;
      case 'lte': return d <= a;
      case 'between': {
        const lo = a && b ? (a < b ? a : b) : a || '';
        const hi = a && b ? (a < b ? b : a) : b || '9999-12-31';
        return d >= lo && d <= hi;
      }
      default: return true;
    }
  }
  const t = textOf(col, row).trim().toLowerCase();
  const a = String(rule.a ?? '').trim().toLowerCase();
  switch (op) {
    case 'contains': return t.includes(a);
    case 'not_contains': return !t.includes(a);
    case 'eq': return t === a;
    case 'ne': return t !== a;
    case 'starts': return t.startsWith(a);
    case 'ends': return t.endsWith(a);
    case 'empty': return !t;
    case 'not_empty': return !!t;
    default: return true;
  }
}

/** A value list's pick, as stored: { in: [...] } or { out: [...] } (arrays or Sets). */
export function pickHit(pick, col, row) {
  const t = textOf(col, row).trim();
  const has = (l) => (l instanceof Set ? l.has(t) : l.includes(t));
  return pick.in ? has(pick.in) : !has(pick.out);
}
const prepared = (picks) => picks.map(([p, c]) => [p.in ? { in: new Set(p.in) } : { out: new Set(p.out) }, c]);
const pickOn = (pick) => !!pick && (Array.isArray(pick.in) || (Array.isArray(pick.out) && pick.out.length > 0));

/** A clean copy of a state: defaults filled in, junk dropped, sizes capped. */
export function normalizeState(raw, base = null) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const b = base || {};
  const rules = (Array.isArray(s.rules) ? s.rules : b.rules || [])
    .filter((r) => r && typeof r === 'object' && typeof r.col === 'string')
    .slice(0, MAX_RULES)
    .map((r, i) => ({ id: String(r.id || `r${i + 1}`), col: r.col, op: String(r.op || ''), a: r.a == null ? '' : String(r.a), b: r.b == null ? '' : String(r.b) }));
  const picks = {};
  Object.entries(s.picks && typeof s.picks === 'object' ? s.picks : b.picks || {}).forEach(([k, p]) => {
    if (!p || typeof p !== 'object') return;
    if (Array.isArray(p.in)) picks[k] = { in: p.in.map(String).slice(0, MAX_PICKS) };
    else if (Array.isArray(p.out) && p.out.length) picks[k] = { out: p.out.map(String).slice(0, MAX_PICKS) };
  });
  const sortIn = s.sort === undefined ? b.sort : s.sort;
  const sort = sortIn && typeof sortIn === 'object' && sortIn.col ? { col: String(sortIn.col), dir: sortIn.dir === 'desc' ? 'desc' : 'asc' } : null;
  const order = (Array.isArray(s.order) ? s.order : b.order || []).filter((k) => typeof k === 'string');
  const vis = {};
  Object.entries(s.vis && typeof s.vis === 'object' ? s.vis : b.vis || {}).forEach(([k, v]) => { if (typeof v === 'boolean') vis[k] = v; });
  const widths = {};
  Object.entries(s.widths && typeof s.widths === 'object' ? s.widths : b.widths || {}).forEach(([k, v]) => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) widths[k] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  });
  return { rules, match: (s.match ?? b.match) === 'any' ? 'any' : 'all', picks, sort, order: [...new Set(order)], vis, widths };
}

/** The built-in default: nothing filtered, the screen's own sort and layout. */
export function defaultState({ sort = null } = {}) {
  return normalizeState({ rules: [], match: 'all', picks: {}, sort, order: [], vis: {}, widths: {} });
}

/** The same view? (rule ids and key order do not count). */
export function sameState(a, b) {
  const canon = (s) => {
    const n = normalizeState(s);
    const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    return JSON.stringify({
      rules: n.rules.map(({ col, op, a: x, b: y }) => [col, op, x, y]),
      match: n.match,
      picks: sorted(n.picks),
      sort: n.sort,
      order: n.order,
      vis: sorted(n.vis),
      widths: sorted(n.widths),
    });
  };
  return canon(a) === canon(b);
}

/** The rules that filter (complete, on a column this table has). */
export function activeRules(state, columns) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return (state.rules || []).filter((r) => ruleReady(r, byKey.get(r.col))).map((r) => [r, byKey.get(r.col)]);
}
/** The heading value lists that filter. */
export function activePicks(state, columns, except = '') {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return Object.entries(state.picks || {}).filter(([k, p]) => k !== except && byKey.has(k) && pickOn(p)).map(([k, p]) => [p, byKey.get(k)]);
}
/** How many filters are on: each rule that filters plus each column with a value pick. */
export function filterCount(state, columns) {
  return activeRules(state, columns).length + activePicks(state, columns).length;
}

function passes(rules, match, picks, row) {
  if (!picks.every(([p, c]) => pickHit(p, c, row))) return false;
  if (!rules.length) return true;
  return match === 'any' ? rules.some(([r, c]) => ruleHit(r, c, row)) : rules.every(([r, c]) => ruleHit(r, c, row));
}

/** Compare two cells of a column for sorting: blanks always last. */
export function compareCells(col, a, b) {
  if (col.sortBy) {
    // The column sorts on something else than it shows (a vendor by name, not number).
    const x = col.sortBy(a);
    const y = col.sortBy(b);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x ?? '').localeCompare(String(y ?? ''), 'en-US', { numeric: true, sensitivity: 'base' });
  }
  const kind = kindOf(col);
  if (kind === 'number') {
    const x = numOf(col, a);
    const y = numOf(col, b);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
    return x - y;
  }
  const x = kind === 'date' ? dayOf(col, a) : textOf(col, a).trim();
  const y = kind === 'date' ? dayOf(col, b) : textOf(col, b).trim();
  if (!x || !y) return !x === !y ? 0 : !x ? 1 : -1;
  return x.localeCompare(y, 'en-US', { numeric: true, sensitivity: 'base' });
}

/** The rows a view leaves, in its order. Rows are never copied or changed. */
export function applyView(rows, columns, state) {
  const list = rows || [];
  const rules = activeRules(state, columns);
  const picks = prepared(activePicks(state, columns));
  const kept = rules.length || picks.length ? list.filter((r) => passes(rules, state.match, picks, r)) : list;
  const col = state.sort ? columns.find((c) => c.key === state.sort.col && !c.noSort) : null;
  if (!col) return kept;
  const dir = state.sort.dir === 'desc' ? -1 : 1;
  return kept.map((r, i) => [r, i]).sort((x, y) => {
    const c = compareCells(col, x[0], y[0]);
    // Blanks stay last whichever way the column sorts.
    const blankX = isNumeric(col) ? Number.isNaN(numOf(col, x[0])) : !textOf(col, x[0]).trim();
    const blankY = isNumeric(col) ? Number.isNaN(numOf(col, y[0])) : !textOf(col, y[0]).trim();
    if (blankX !== blankY) return blankX ? 1 : -1;
    return c ? c * dir : x[1] - y[1];
  }).map(([r]) => r);
}

/**
 * A heading's value list (Excel's): every value the column holds in the rows
 * the OTHER filters leave, with how many rows hold it. Blanks are '' (shown
 * as "(Blanks)"), listed last. Numbers and dates read in their own order.
 */
export function distinctValues(rows, columns, state, key) {
  const col = columns.find((c) => c.key === key);
  if (!col) return [];
  const rules = activeRules(state, columns);
  const picks = prepared(activePicks(state, columns, key));
  const seen = new Map();
  (rows || []).forEach((r) => {
    if (!passes(rules, state.match, picks, r)) return;
    const t = textOf(col, r).trim();
    const hit = seen.get(t);
    if (hit) hit.n += 1;
    else seen.set(t, { text: t, n: 1, row: r });
  });
  const list = [...seen.values()];
  list.sort((a, b) => (!a.text || !b.text ? (!a.text ? 1 : -1) : compareCells(col, a.row, b.row) || a.text.localeCompare(b.text, 'en-US', { numeric: true })));
  return list.map(({ text, n }) => ({ text, n }));
}

/**
 * The columns in the view's order, each with `hidden` and `width`. Fixed
 * columns keep their own place; the rest follow `order` (a key it does not
 * name - a column added later - keeps its place after its default neighbor).
 */
export function arrange(columns, state) {
  const keys = columns.map((c) => c.key);
  const movable = columns.filter((c) => !c.fixed).map((c) => c.key);
  const out = (state.order || []).filter((k) => movable.includes(k));
  movable.forEach((k, i) => {
    if (out.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const p = out.indexOf(movable[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    out.splice(at, 0, k);
  });
  // Fixed columns back in their own slots.
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const final = [];
  let m = 0;
  keys.forEach((k) => { final.push(byKey.get(k).fixed ? k : out[m++]); });
  return final.map((k) => {
    const c = byKey.get(k);
    const hidden = !c.fixed && (state.vis?.[k] === undefined ? !!c.off : !state.vis[k]);
    return { ...c, hidden, width: state.widths?.[k] || c.width };
  });
}

/** The order with one column moved one place left (-1) or right (+1), over hidden ones too. */
export function moveColumn(columns, state, key, dir) {
  const arranged = arrange(columns, state);
  const order = arranged.filter((c) => !c.fixed).map((c) => c.key);
  const at = order.indexOf(key);
  // Step over hidden neighbors so the move shows on screen.
  let to = at + dir;
  while (to >= 0 && to < order.length && arranged.find((c) => c.key === order[to])?.hidden) to += dir;
  if (at < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(at, 1);
  next.splice(to, 0, key);
  return next;
}
/** Whether a column can move left (-1) / right (+1) among the shown ones. */
export function canMove(columns, state, key, dir) {
  const shown = arrange(columns, state).filter((c) => !c.fixed && !c.hidden).map((c) => c.key);
  const at = shown.indexOf(key);
  return at >= 0 && at + dir >= 0 && at + dir < shown.length;
}

/**
 * The view as a table for linesExport (Excel / CSV / PDF): exactly the rows it
 * leaves, in its order, and the columns shown, in their order and widths.
 * A column may export as several (`exportAs: [{ label, num, width, get(r) }]`)
 * or not at all (`exportAs: []`). `totals`: true adds a Totals line over the
 * columns marked `total`.
 */
export function viewTable(rows, shownColumns, { title, subtitle = '', period = '', totals = true, totalLabel = 'Total' } = {}) {
  const cols = shownColumns.flatMap((c) => (Array.isArray(c.exportAs) ? c.exportAs : [{
    label: c.label, num: isNumeric(c), width: c.width || 120, total: !!c.total,
    get: (r) => (isNumeric(c) ? (Number.isNaN(numOf(c, r)) ? '' : numOf(c, r)) : textOf(c, r)),
  }]));
  const body = rows.map((r) => cols.map((x) => x.get(r)));
  const anyTotal = totals && cols.some((x) => x.total);
  const sums = cols.map((x, i) => (x.total ? r2(body.reduce((s, line) => s + (Number(line[i]) || 0), 0)) : null));
  const first = cols.findIndex((x) => !x.total);
  return {
    title, period,
    subtitle: subtitle || `${rows.length.toLocaleString('en-US')} rows`,
    columns: cols.map(({ label, num, width }) => ({ label, num: !!num, width })),
    rows: body,
    totals: anyTotal ? cols.map((x, i) => (x.total ? sums[i] : i === first ? `${totalLabel} - ${rows.length.toLocaleString('en-US')} rows` : '')) : null,
  };
}

/** Add up a numeric column over rows (blanks count as 0), to the cent. */
export function sumColumn(rows, col) {
  return r2((rows || []).reduce((s, r) => { const v = numOf(col, r); return s + (Number.isNaN(v) ? 0 : v); }, 0));
}

/** A short, plain description of a rule ("Customer contains Sachse"). */
export function ruleText(rule, col) {
  if (!col) return '';
  const op = opOf(col, rule.op);
  const kind = kindOf(col);
  const show = (v) => (kind === 'date' ? usDay(dayOf({ value: () => v }, null)) : String(v ?? '').trim());
  if (op.none) return `${col.label} ${op.label.toLowerCase()}`;
  if (op.two) return `${col.label} ${op.label.toLowerCase()} ${show(rule.a) || '...'} and ${show(rule.b) || '...'}`;
  return `${col.label} ${op.label.toLowerCase()} ${show(rule.a)}`;
}
const usDay = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '');

let seq = 0;
/** A new rule id, unique on the page. */
export const ruleId = () => `r${Date.now().toString(36)}${(seq += 1)}`;
