// Sheets: the pure logic behind merges, filters, conditional formats, data
// validation, smart fill, charts, F4, AutoSum, find / replace and variables.
// Nothing here touches React or writes the document; SheetEditor does that.
import { formatValue, parseNumber, parseDateText } from './format.js';
import { isErr, compare } from './formula/eval.js';
import { tokenize, decodeFormula, shiftFormula, refA1, a1 } from './formula/parse.js';

// ── merges ───────────────────────────────────────────────────────────────
const mergeCache = new WeakMap();
/** The tab's merges as index rectangles (a merge whose corner row or column is gone is left out). */
export function mergesOf(ctx, tab) {
  let list = mergeCache.get(tab);
  if (list) return list;
  list = [];
  tab.merges?.forEach((v, k) => {
    const [r1, c1] = k.split('.');
    const rect = ctx.rect(tab, { r1, c1, r2: v.r2, c2: v.c2 });
    if (rect && (rect.r2 > rect.r1 || rect.c2 > rect.c1)) list.push(rect);
  });
  // An index by row (a merge is listed under each of its rows, up to INDEX_ROWS of them);
  // taller merges are few and stay in a short list that is scanned.
  Object.defineProperty(list, 'byRow', { value: new Map() });
  Object.defineProperty(list, 'tall', { value: [] });
  for (const m of list) {
    if (m.r2 - m.r1 >= INDEX_ROWS) { list.tall.push(m); continue; }
    for (let r = m.r1; r <= m.r2; r += 1) {
      let at = list.byRow.get(r);
      if (!at) list.byRow.set(r, (at = []));
      at.push(m);
    }
  }
  mergeCache.set(tab, list);
  return list;
}
const INDEX_ROWS = 200;
const inside = (m, r, c) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2;
export function mergeAt(list, r, c) {
  if (!list.length) return null;
  if (!list.byRow) return list.find((m) => inside(m, r, c)) || null;
  return list.byRow.get(r)?.find((m) => inside(m, r, c)) || list.tall.find((m) => inside(m, r, c)) || null;
}
/** A selection grown until no merge sticks out of it (Excel's rule). */
export function expandRect(list, rect) {
  let { r1, c1, r2, c2 } = rect;
  for (let grew = true; grew;) {
    grew = false;
    for (const m of list) {
      if (m.r2 < r1 || m.r1 > r2 || m.c2 < c1 || m.c1 > c2) continue;
      if (m.r1 < r1) { r1 = m.r1; grew = true; }
      if (m.c1 < c1) { c1 = m.c1; grew = true; }
      if (m.r2 > r2) { r2 = m.r2; grew = true; }
      if (m.c2 > c2) { c2 = m.c2; grew = true; }
    }
  }
  return { r1, c1, r2, c2 };
}

// ── filter (hides rows for everyone, like Excel's sheet filter) ──────────
/** The filter's header row and columns as indexes, and the data rows under it. */
export function filterRect(ctx, tab) {
  const f = tab.filter?.get('f');
  if (!f) return null;
  const r = ctx.rowIndex(tab, f.r), c1 = ctx.colIndex(tab, f.c1), c2 = ctx.colIndex(tab, f.c2);
  if (r < 0 || c1 < 0 || c2 < 0) return null;
  let last = r;
  tab.cells.forEach((cell, k) => {
    const [ri, ci] = k.split('.');
    const ri2 = ctx.rowIndex(tab, ri), cc = ctx.colIndex(tab, ci);
    if (ri2 > last && cc >= Math.min(c1, c2) && cc <= Math.max(c1, c2) && (cell.v != null || cell.f != null)) last = ri2;
  });
  return { r, c1: Math.min(c1, c2), c2: Math.max(c1, c2), last, crit: f.crit || {}, raw: f };
}

/** Does one value pass a condition {op, a, b}? (filters and validation share it) */
export function passes(op, v, a, b) {
  const blank = v == null || v === '';
  if (op === 'empty') return blank;
  if (op === 'notEmpty') return !blank;
  if (!op) return true;
  const num = (x) => (typeof x === 'number' ? x : parseNumber(x) ?? parseDateText(x ?? '')?.v ?? null);
  if (op === 'contains' || op === 'notContains') {
    const has = String(v ?? '').toLowerCase().includes(String(a ?? '').toLowerCase());
    return op === 'contains' ? has : !has;
  }
  const x = typeof v === 'number' ? v : num(v), y = num(a);
  if (op === 'between') { const z = num(b); return x != null && y != null && z != null && x >= Math.min(y, z) && x <= Math.max(y, z); }
  const cmp = x != null && y != null ? compare(x, y) : compare(String(v ?? '').toLowerCase(), String(a ?? '').toLowerCase());
  return op === 'gt' ? cmp > 0 : op === 'gte' ? cmp >= 0 : op === 'lt' ? cmp < 0 : op === 'lte' ? cmp <= 0 : op === 'eq' ? cmp === 0 : op === 'neq' ? cmp !== 0 : true;
}

/** Text a filter compares by: what the cell shows. */
export const shownText = (eng, ctx, tab, r, c) => {
  const cell = ctx.cell(tab, r, c);
  return formatValue(eng.cellValue(tab, r, c), cell?.s);
};

/** Row indexes hidden: by hand, in a collapsed group, or because the filter leaves them out. */
export function hiddenRows(ctx, eng, tab) {
  const out = filteredOut(ctx, eng, tab);
  tab.hidden?.forEach((_, id) => { const i = ctx.rowIndex(tab, id); if (i >= 0) out.add(i); });
  for (const g of groupsOf(ctx, tab, 'rows')) if (g.collapsed) for (let i = g.s; i <= g.e; i += 1) out.add(i);
  return out;
}

// ── row and column groups (the outline) ─────────────────────────────────
export const GROUP_DEPTH = 3;
/** The tab's groups on one axis as {id, s, e, collapsed, level} (level 1 = outermost), outer first. */
export function groupsOf(ctx, tab, axis) {
  const list = [];
  tab.groups?.forEach((g, id) => {
    if (g.axis !== axis) return;
    const idx = axis === 'rows' ? ctx.rowIndex : ctx.colIndex;
    const a = idx(tab, g.a), b = idx(tab, g.b);
    if (a < 0 || b < 0) return;
    list.push({ id, s: Math.min(a, b), e: Math.max(a, b), collapsed: !!g.collapsed });
  });
  list.sort((x, y) => x.s - y.s || y.e - x.e);
  for (const g of list) g.level = 1 + list.filter((o) => o !== g && o.s <= g.s && o.e >= g.e && (o.s < g.s || o.e > g.e || o.id < g.id)).length;
  return list;
}
/** Why a new group s..e on this axis cannot be made, or ''. Groups nest; they never cross. */
export function groupProblem(list, s, e) {
  for (const g of list) {
    if (g.s === s && g.e === e) return 'Those rows are already a group.';
    const crosses = (s < g.s && e >= g.s && e < g.e) || (s > g.s && s <= g.e && e > g.e);
    if (crosses) return 'A group has to sit inside another group or around it, not across it.';
  }
  const outside = list.filter((g) => g.s <= s && g.e >= e).length;
  // The longest chain of groups inside the new one: for each, how many inside groups hold it.
  const inner = list.filter((g) => g.s >= s && g.e <= e);
  let deepest = 0;
  for (const g of inner) deepest = Math.max(deepest, inner.filter((o) => o.s <= g.s && o.e >= g.e).length);
  if (outside + 1 + deepest > GROUP_DEPTH) return `Groups go ${GROUP_DEPTH} levels deep at most.`;
  return '';
}
/** Only the rows the filter leaves out - the ones Delete, fill, paste and formats skip (Excel). */
export function filteredOut(ctx, eng, tab) {
  const out = new Set();
  const f = filterRect(ctx, tab);
  if (!f) return out;
  const tests = [];
  for (const [colId, cv] of Object.entries(f.crit)) {
    const c = ctx.colIndex(tab, colId);
    if (c < f.c1 || c > f.c2) continue;
    const hide = cv.hide?.length ? new Set(cv.hide) : null;
    tests.push((r) => {
      const text = shownText(eng, ctx, tab, r, c);
      if (hide && hide.has(text)) return false;
      return cv.op ? passes(cv.op, eng.cellValue(tab, r, c), cv.a, cv.b) : true;
    });
  }
  if (!tests.length) return out;
  for (let r = f.r + 1; r <= f.last; r += 1) if (!tests.every((t) => t(r))) out.add(r);
  return out;
}
export function hiddenCols(ctx, tab) {
  const out = new Set();
  tab.hidden?.forEach((_, id) => { const i = ctx.colIndex(tab, id); if (i >= 0) out.add(i); });
  for (const g of groupsOf(ctx, tab, 'cols')) if (g.collapsed) for (let i = g.s; i <= g.e; i += 1) out.add(i);
  return out;
}

// ── conditional formats ───────────────────────────────────────────────────
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hexRgb = (h) => { let x = h.slice(1); if (x.length === 3) x = x.split('').map((ch) => ch + ch).join(''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const rgbHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
export function mixColor(colors, t) {
  const cs = colors.map(hexRgb);
  if (cs.length === 3) { const [a, b, c] = cs; return t <= 0.5 ? rgbHex(a.map((v, i) => lerp(v, b[i], t * 2))) : rgbHex(b.map((v, i) => lerp(v, c[i], (t - 0.5) * 2))); }
  return rgbHex(cs[0].map((v, i) => lerp(v, cs[1][i], t)));
}

/** A function (r, c) -> the style patch the tab's rules give that cell (first matching rule wins; scales add a fill). */
export function conditionalStyler(ctx, eng, tab) {
  const rules = [];
  tab.cf?.forEach((rule, id) => { const rect = ctx.rect(tab, rule.range); if (rect) rules.push({ ...rule, id, rect }); });
  if (!rules.length) return null;
  rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const scales = new Map();
  const scaleOf = (rule) => {
    if (scales.has(rule.id)) return scales.get(rule.id);
    let lo = Infinity, hi = -Infinity, budget = CELL_BUDGET;
    for (let r = rule.rect.r1; r <= rule.rect.r2 && budget > 0; r += 1) {
      for (let c = rule.rect.c1; c <= rule.rect.c2 && budget > 0; c += 1, budget -= 1) {
        const v = eng.cellValue(tab, r, c);
        if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    const s = { lo, hi };
    scales.set(rule.id, s);
    return s;
  };
  // One answer per cell per engine build: the grid asks again on every scroll.
  const seen = new Map();
  return (r, c) => {
    const key = r * 4096 + c;
    if (seen.has(key)) return seen.get(key);
    const out = styleFor(r, c);
    seen.set(key, out);
    return out;
  };
  function styleFor(r, c) {
    for (const rule of rules) {
      const { rect } = rule;
      if (r < rect.r1 || r > rect.r2 || c < rect.c1 || c > rect.c2) continue;
      const v = eng.cellValue(tab, r, c);
      if (rule.type === 'scale') {
        if (typeof v !== 'number' || !rule.colors) continue;
        const { lo, hi } = scaleOf(rule);
        return { bg: mixColor(rule.colors, hi > lo ? (v - lo) / (hi - lo) : 0.5) };
      }
      if (ruleMatches(rule, v, eng, ctx, tab, r, c)) return rule.style || {};
    }
    return null;
  }
}
/** Cells one rule, one dropdown list or one chart may read: stored ranges come from colleagues' browsers. */
const CELL_BUDGET = 100000;
export const CHART_POINTS = 5000;
function ruleMatches(rule, v, eng, ctx, tab, r, c) {
  if (isErr(v)) return false;
  switch (rule.type) {
    case 'formula': {
      if (!rule.f) return false;
      // Written for the range's top-left cell; moved to each cell like a fill would.
      const text = shiftFormula(decodeFormula(rule.f, ctx, tab.id), r - rule.rect.r1, c - rule.rect.c1);
      const out = eng.evalText(text, tab.id, r, c);
      return out === true || (typeof out === 'number' && out !== 0);
    }
    case 'before': case 'after': {
      const d = parseDateText(String(rule.a ?? ''))?.v ?? parseNumber(rule.a);
      if (typeof v !== 'number' || d == null) return false;
      return rule.type === 'before' ? Math.floor(v) < Math.floor(d) : Math.floor(v) > Math.floor(d);
    }
    default: return passes(rule.type, v, rule.a, rule.b);
  }
}

// ── data validation ──────────────────────────────────────────────────────
/** The validation rule over (r, c), with its index rectangle, or null. */
export function validationAt(ctx, tab, r, c) {
  let hit = null;
  tab.dv?.forEach((rule, id) => {
    if (hit) return;
    const rect = ctx.rect(tab, rule.range);
    if (rect && r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2) hit = { ...rule, id, rect };
  });
  return hit;
}
/** The choices of a dropdown rule: its items, or the values of its range. */
export function listItems(rule, eng, ctx, tab) {
  if (rule.kind === 'list') return rule.items || [];
  if (rule.kind !== 'range' || !rule.src) return [];
  const text = decodeFormula(rule.src, ctx, tab.id);
  let toks;
  try { toks = tokenize(text.slice(1)); } catch { return []; }
  const rf = toks.length === 1 && toks[0].type === 'ref' ? toks[0].value : null;
  if (!rf) return [];
  const t = rf.sheet != null ? ctx.tabByName(rf.sheet) : tab;
  if (!t) return [];
  const r1 = rf.a.r ?? 0, r2 = rf.b ? rf.b.r ?? t.rows.length - 1 : r1, c1 = rf.a.c ?? 0, c2 = rf.b ? rf.b.c ?? t.cols.length - 1 : c1;
  const out = [];
  let budget = CELL_BUDGET;
  for (let r = Math.min(r1, r2); r <= Math.min(Math.max(r1, r2), t.rows.length - 1) && out.length < 500 && budget > 0; r += 1) {
    for (let c = Math.min(c1, c2); c <= Math.min(Math.max(c1, c2), t.cols.length - 1) && budget > 0; c += 1, budget -= 1) {
      const s = shownText(eng, ctx, t, r, c);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}
/** Is a value allowed by the rule? (blank always is) */
export function validValue(rule, v, eng, ctx, tab) {
  if (v == null || v === '') return true;
  switch (rule.kind) {
    case 'list': case 'range': return listItems(rule, eng, ctx, tab).some((x) => x.toLowerCase() === String(typeof v === 'number' ? formatValue(v) : v).toLowerCase());
    case 'checkbox': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && passes(rule.op || 'between', v, rule.a, rule.b);
    case 'date': {
      const d = (x) => (typeof x === 'number' ? x : parseDateText(String(x ?? ''))?.v);
      return typeof v === 'number' && passes(rule.op || 'between', Math.floor(v), d(rule.a), d(rule.b));
    }
    default: return true;
  }
}
export const ruleWords = (rule) => {
  const opWord = { between: 'between', gte: 'at least', lte: 'at most', gt: 'more than', lt: 'less than', eq: 'equal to' }[rule.op || 'between'];
  if (rule.kind === 'number' || rule.kind === 'date') return `a ${rule.kind} ${opWord} ${rule.a ?? ''}${rule.op === 'between' || !rule.op ? ` and ${rule.b ?? ''}` : ''}`;
  if (rule.kind === 'checkbox') return 'checked or unchecked';
  return 'one of the items in the list';
};

// ── smart fill ───────────────────────────────────────────────────────────
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function cycleOf(s) {
  const t = String(s).trim();
  for (const [list, n] of [[DAYS, 7], [MONTHS, 12]]) {
    const full = list.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    if (full >= 0) return { list, at: full, n, short: false, upper: t === t.toUpperCase() && t.length > 1 };
    const short = list.findIndex((x) => x.slice(0, 3).toLowerCase() === t.toLowerCase());
    if (short >= 0) return { list, at: short, n, short: true, upper: t === t.toUpperCase() };
  }
  const q = t.match(/^Q([1-4])$/i);
  if (q) return { list: ['Q1', 'Q2', 'Q3', 'Q4'], at: +q[1] - 1, n: 4, short: false };
  return null;
}
const say = (cy, i) => {
  const w = cy.list[((i % cy.n) + cy.n) % cy.n];
  const s = cy.short ? w.slice(0, 3) : w;
  return cy.upper ? s.toUpperCase() : s;
};
/**
 * The next `count` values continuing `src` (cells in fill order, each {v, f?, s?}).
 * Returns null when the cells should simply be copied (formulas, plain text).
 */
export function seriesNext(src, count, back = false) {
  const vals = src.map((x) => x?.v);
  if (!vals.length || src.some((x) => x?.f)) return null;
  const order = back ? -1 : 1;
  if (vals.every((v) => typeof v === 'number')) {
    const isDate = ['date', 'datetime'].includes(src[0]?.s?.nf);
    if (vals.length === 1 && !isDate) return null;               // one number copies, like Excel
    const step = vals.length === 1 ? 1 : (vals[vals.length - 1] - vals[0]) / (vals.length - 1);
    const from = back ? vals[0] : vals[vals.length - 1];
    return Array.from({ length: count }, (_, k) => from + order * step * (k + 1));
  }
  if (vals.every((v) => typeof v === 'string')) {
    const cys = vals.map(cycleOf);
    if (cys.every(Boolean) && cys.every((c) => c.list === cys[0].list)) {
      const step = cys.length === 1 ? 1 : cys[cys.length - 1].at - cys[cys.length - 2].at || 1;
      const base = back ? cys[0] : cys[cys.length - 1];
      return Array.from({ length: count }, (_, k) => say(base, base.at + order * step * (k + 1)));
    }
    const ms = vals.map((v) => v.match(/^(.*?)(\d+)(\D*)$/));
    if (ms.every(Boolean) && ms.every((m) => m[1] === ms[0][1] && m[3] === ms[0][3])) {
      const ns = ms.map((m) => +m[2]);
      const step = ns.length === 1 ? 1 : (ns[ns.length - 1] - ns[0]) / (ns.length - 1);
      const from = back ? ns[0] : ns[ns.length - 1];
      const width = ms[0][2].startsWith('0') ? ms[0][2].length : 0;
      return Array.from({ length: count }, (_, k) => {
        const n = from + order * step * (k + 1);
        return `${ms[0][1]}${width ? String(n).padStart(width, '0') : n}${ms[0][3]}`;
      });
    }
  }
  return null;
}

// ── charts ───────────────────────────────────────────────────────────────
/**
 * The chart's numbers from its range: the first column names the categories
 * when it holds text (or the rule says header), each other column is a series
 * named by the header row.
 */
export function chartData(eng, ctx, tab, rect0, header = null) {
  // At most CHART_POINTS values in all: a chart over a whole column reads its first rows only.
  const cols = Math.min(rect0.c2 - rect0.c1 + 1, 50);
  const rect = { ...rect0, c2: rect0.c1 + cols - 1, r2: Math.min(rect0.r2, rect0.r1 + Math.max(1, Math.floor(CHART_POINTS / cols))) };
  const v = (r, c) => eng.cellValue(tab, r, c);
  const firstRowText = [];
  for (let c = rect.c1; c <= rect.c2; c += 1) firstRowText.push(typeof v(rect.r1, c) === 'string' || v(rect.r1, c) == null);
  const hasHeader = header ?? (rect.r2 > rect.r1 && firstRowText.slice(rect.c2 > rect.c1 ? 1 : 0).every(Boolean));
  const r0 = hasHeader ? rect.r1 + 1 : rect.r1;
  let catCol = false;
  if (rect.c2 > rect.c1) {
    let textish = 0, total = 0;
    for (let r = r0; r <= rect.r2; r += 1) { const x = v(r, rect.c1); if (x != null) { total += 1; if (typeof x !== 'number') textish += 1; } }
    catCol = textish > 0 && textish >= total / 2;
  }
  const sc1 = catCol ? rect.c1 + 1 : rect.c1;
  const categories = [];
  for (let r = r0; r <= rect.r2; r += 1) {
    const cell = ctx.cell(tab, r, rect.c1);
    categories.push(catCol ? formatValue(v(r, rect.c1), cell?.s) : String(r - r0 + 1));
  }
  const series = [];
  for (let c = sc1; c <= rect.c2; c += 1) {
    const name = hasHeader ? formatValue(v(rect.r1, c), ctx.cell(tab, rect.r1, c)?.s) || `Series ${series.length + 1}` : `Series ${series.length + 1}`;
    const values = [];
    for (let r = r0; r <= rect.r2; r += 1) { const x = v(r, c); values.push(typeof x === 'number' ? x : null); }
    series.push({ name, values, nf: ctx.cell(tab, r0, c)?.s?.nf || '' });
  }
  return { categories, series };
}

// ── editing helpers ─────────────────────────────────────────────────────
/** F4: the reference at the caret cycles A1 -> $A$1 -> A$1 -> $A1 -> A1. */
export function cycleRef(text, caret) {
  if (!text.startsWith('=')) return null;
  let toks;
  try { toks = tokenize(text.slice(1)); } catch { return null; }
  const at = caret - 1;
  const tk = toks.find((t) => t.type === 'ref' && at >= t.start && at <= t.end) || [...toks].reverse().find((t) => t.type === 'ref' && t.end <= at);
  if (!tk) return null;
  const next = (p) => {
    if (p.r == null || p.c == null) return { ...p, ar: !p.ar, ac: !p.ac };
    const state = (p.ac ? 2 : 0) + (p.ar ? 1 : 0);      // 0 A1, 3 $A$1, 1 A$1, 2 $A1
    const to = { 0: 3, 3: 1, 1: 2, 2: 0 }[state];
    return { ...p, ac: to >= 2, ar: to === 3 || to === 1 };
  };
  const ref = tk.value;
  const out = refA1({ ...ref, a: next(ref.a), b: ref.b ? next(ref.b) : null });
  const start = tk.start + 1, end = tk.end + 1;
  return { text: text.slice(0, start) + out + text.slice(end), caret: start + out.length };
}

/** Alt+=: the numbers right above the cell (else to its left) as a SUM formula. */
export function autoSum(eng, tab, r, c) {
  const isNum = (rr, cc) => typeof eng.cellValue(tab, rr, cc) === 'number';
  let top = r - 1;
  while (top >= 0 && !isNum(top, c)) top -= 1;
  if (top >= 0 && top === r - 1) {
    let start = top;
    while (start > 0 && isNum(start - 1, c)) start -= 1;
    return `=SUM(${a1(start, c)}:${a1(r - 1, c)})`;
  }
  let left = c - 1;
  if (left >= 0 && isNum(r, left)) {
    let start = left;
    while (start > 0 && isNum(r, start - 1)) start -= 1;
    return `=SUM(${a1(r, start)}:${a1(r, c - 1)})`;
  }
  return '=SUM()';
}

/** Find and Replace on one value's text. */
export function findIn(text, q, { matchCase = false, whole = false } = {}) {
  if (!q) return false;
  const a = matchCase ? text : text.toLowerCase(), b = matchCase ? q : q.toLowerCase();
  return whole ? a === b : a.includes(b);
}
export function replaceIn(text, q, rep, { matchCase = false, whole = false } = {}) {
  if (!q) return text;
  if (whole) return findIn(text, q, { matchCase, whole }) ? rep : text;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  return text.replace(re, () => rep);
}

/** Split text to columns: by a separator, or 'auto' (comma, tab, semicolon, then space). */
export function splitText(text, sep) {
  const s = String(text ?? '');
  let by = sep;
  if (sep === 'auto') by = [',', '\t', ';'].find((x) => s.includes(x)) || ' ';
  return s.split(by).map((x) => x.trim());
}

// ── variables ({{token}} in text, VAR("token") in formulas) ──────────────
export const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
/** Text with each {{token}} that has a value filled in; parts for the dotted underline. */
export function fillTokens(text, values) {
  if (typeof text !== 'string' || text.indexOf('{{') < 0) return null;
  const parts = [];
  let last = 0, any = false;
  text.replace(TOKEN_RE, (m, token, off) => {
    if (off > last) parts.push({ text: text.slice(last, off) });
    const has = values && values[token] != null && values[token] !== '';
    parts.push({ text: has ? String(values[token]) : m, token, missing: !has });
    any = true;
    last = off + m.length;
    return m;
  });
  if (!any) return null;
  if (last < text.length) parts.push({ text: text.slice(last) });
  return { parts, text: parts.map((p) => p.text).join('') };
}
