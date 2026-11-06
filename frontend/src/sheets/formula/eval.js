// Sheets formulas: evaluating a workbook. Values are numbers, strings,
// booleans, null (blank) or an Err; a range argument is a Rng, a worked-out
// array an Arr.
//
// shortcut: full recompute, upgrade to a dependency graph when sheets pass ~20k formulas.
// Every doc change builds a new engine (createEngine); values are worked out
// lazily, once each, as the grid or a dependent formula asks for them.
//
// Arrays spill (Excel 365 / Google Sheets): a formula whose answer is more
// than one cell shows its first value and fills the cells right and below,
// or reads #SPILL! when one of those cells holds something. Operators work
// element by element over ranges (=A1:A9*2, =FILTER(A:B, A:A>5)).
import { parse, decodeFormula, tokenize } from './parse.js';
import { FN } from './functions.js';
import { Err, isErr, err, Rng, Arr, isMulti, toNum, toStr, toBool, compare } from './values.js';

export { Err, isErr, err, Rng, Arr, toNum, toStr, toBool, compare };

const parseCache = new Map();
function parsed(text) {
  let t = parseCache.get(text);
  if (t === undefined) {
    try { t = parse(text); } catch { t = null; }
    if (parseCache.size > 20000) parseCache.clear();
    parseCache.set(text, t);
  }
  return t;
}

// A stored formula that may answer with an array: a range in it, a name, or a
// function that makes arrays. Only these are asked when an empty cell may be spilled into.
const MAY_SPILL = /:|\b(FILTER|SORT|UNIQUE|SEQUENCE|TRANSPOSE|ARRAYFORMULA|SPLIT|OFFSET|INDIRECT)\s*\(|^=\s*[A-Za-z_][A-Za-z0-9_.]*\s*$/i;
const SPILL_MAX = 100000;
const filled = (x) => !!x && (x.f != null || (x.v != null && x.v !== ''));

/**
 * ctx: buildCtx's view. opts.vars = { tokens: Set, values: {token: text} }
 * for VAR("token").
 */
export function createEngine(ctx, opts = {}) {
  const memo = new Map();
  const busy = new Set();
  const spills = new Map();      // origin key -> { h, w, rng, blocked }
  const candidates = new Map();  // tab id -> [{r, c}] of formulas that may spill
  const spillMaps = new Map();   // tab id -> Map('r|c' -> value), once built
  let building = false;

  const keyOf = (tab, r, c) => `${tab.id}|${r}|${c}`;

  function cellValue(tab, r, c) {
    const cell = ctx.cell(tab, r, c);
    if (!cell || (cell.f == null && (cell.v == null || cell.v === ''))) return spilledInto(tab, r, c);
    if (cell.f == null) return cell.v;
    const key = keyOf(tab, r, c);
    if (memo.has(key)) return memo.get(key);
    if (busy.has(key)) return err('#REF!', 'Circular dependency');
    busy.add(key);
    let v;
    try { v = evalFormula(cell.f, { tab, r, c }); } finally { busy.delete(key); }
    if (v instanceof Rng) {
      if (!isMulti(v)) v = v.h === 1 && v.w === 1 ? v.at(0, 0) : err('#N/A', 'Nothing matched');
      else {
        const sp = { h: v.h, w: v.w, rng: v, blocked: blockedSpill(tab, r, c, v) };
        spills.set(key, sp);
        v = sp.blocked ? err('#SPILL!', sp.blocked) : v.at(0, 0);
      }
    }
    memo.set(key, v);
    return v;
  }

  function blockedSpill(tab, r, c, v) {
    if (v.h * v.w > SPILL_MAX) return 'The result is too large to show';
    if (r + v.h > tab.rows.length || c + v.w > tab.cols.length) return 'The result runs past the edge of the sheet';
    for (let i = 0; i < v.h; i += 1) {
      for (let j = 0; j < v.w; j += 1) {
        if ((i || j) && filled(ctx.cell(tab, r + i, c + j))) return 'Cells in the way - clear them to let this formula spill';
      }
    }
    return '';
  }

  function candidatesOf(tab) {
    let list = candidates.get(tab.id);
    if (!list) {
      list = [];
      tab.cells.forEach((cell, k) => {
        if (!cell || typeof cell.f !== 'string' || !MAY_SPILL.test(cell.f)) return;
        const [ri, ci] = k.split('.');
        const r = ctx.rowIndex(tab, ri), c = ctx.colIndex(tab, ci);
        if (r >= 0 && c >= 0) list.push({ r, c });
      });
      candidates.set(tab.id, list);
    }
    return list;
  }

  /** The value an array formula spills into this empty cell, or null. */
  function spilledInto(tab, r, c) {
    const list = candidatesOf(tab);
    if (!list.length) return null;
    const ready = spillMaps.get(tab.id);
    if (ready) return ready.has(`${r}|${c}`) ? ready.get(`${r}|${c}`) : null;
    if (!building) {
      // The first ask: work out every array on this tab once, then answer from the map.
      building = true;
      const map = new Map();
      // A candidate already being worked out (the formula that asked, or one it
      // depends on) has no answer yet: a map built without it is incomplete,
      // so it answers this one question and is not kept.
      let partial = false;
      try {
        for (const o of list) {
          if (busy.has(keyOf(tab, o.r, o.c))) { partial = true; continue; }
          cellValue(tab, o.r, o.c);
          const sp = spills.get(keyOf(tab, o.r, o.c));
          if (!sp || sp.blocked) continue;
          for (let i = 0; i < sp.h; i += 1) {
            for (let j = 0; j < sp.w; j += 1) {
              if ((i || j) && !map.has(`${o.r + i}|${o.c + j}`)) map.set(`${o.r + i}|${o.c + j}`, plainOf(sp.rng.at(i, j)));
            }
          }
        }
      } finally { building = false; }
      if (!partial) spillMaps.set(tab.id, map);
      return map.has(`${r}|${c}`) ? map.get(`${r}|${c}`) : null;
    }
    // Asked while the map is being built (one array reading another): look directly.
    for (const o of list) {
      if (o.r > r || o.c > c || busy.has(keyOf(tab, o.r, o.c))) continue;
      cellValue(tab, o.r, o.c);
      const sp = spills.get(keyOf(tab, o.r, o.c));
      if (sp && !sp.blocked && r < o.r + sp.h && c < o.c + sp.w) return plainOf(sp.rng.at(r - o.r, c - o.c));
    }
    return null;
  }
  const plainOf = (v) => (v instanceof Rng ? v.at(0, 0) : v);

  function evalFormula(stored, env) {
    const text = decodeFormula(stored, ctx, env.tab.id);
    const tree = parsed(text);
    if (!tree) return err('#ERROR!', 'The formula could not be read');
    const v = node(tree, env);
    if (typeof v === 'number' && !Number.isFinite(v)) return err('#NUM!');
    return v === undefined ? null : v;
  }

  function scalar(v, env) {
    if (!(v instanceof Rng)) return v;
    if (v.h === 1 && v.w === 1) return v.at(0, 0);
    if (v.tab && v.w === 1 && env.r >= v.r1 && env.r <= v.r2 && v.tab === env.tab) return v.at(env.r - v.r1, 0);
    if (v.tab && v.h === 1 && env.c >= v.c1 && env.c <= v.c2 && v.tab === env.tab) return v.at(0, env.c - v.c1);
    return err('#VALUE!');
  }

  function ref(rf, env, asRange = false) {
    const tab = rf.sheet != null ? ctx.tabByName(rf.sheet) : env.tab;
    if (!tab) return err('#REF!');
    const { a, b } = rf;
    if (!b) return asRange ? new Rng(eng, tab, a.r, a.c, a.r, a.c) : cellValue(tab, a.r, a.c);
    const r1 = a.r == null ? 0 : Math.min(a.r, b.r), r2 = a.r == null ? tab.rows.length - 1 : Math.max(a.r, b.r);
    const c1 = a.c == null ? 0 : Math.min(a.c, b.c), c2 = a.c == null ? tab.cols.length - 1 : Math.max(a.c, b.c);
    return new Rng(eng, tab, r1, c1, r2, c2);
  }

  function arith(op, x, y) {
    x = toNum(x); if (isErr(x)) return x;
    y = toNum(y); if (isErr(y)) return y;
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return y === 0 ? err('#DIV/0!') : x / y;
      default: { const p = Math.pow(x, y); return Number.isFinite(p) ? p : err('#NUM!'); }
    }
  }
  function binary(op, a, b) {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (op === '&') return toStr(a) + toStr(b);
    if ('+-*/^'.includes(op)) return arith(op, a, b);
    const c = compare(a, b);
    switch (op) {
      case '=': return c === 0;
      case '<>': return c !== 0;
      case '<': return c < 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      default: return c >= 0;
    }
  }
  /** fn over each element of the arrays (a one-row or one-column side stretches; past an edge is #N/A). */
  function broadcast(xs, fn) {
    const h = Math.max(...xs.map((x) => (x instanceof Rng ? x.h : 1)));
    const w = Math.max(...xs.map((x) => (x instanceof Rng ? x.w : 1)));
    if (h * w > SPILL_MAX) return err('#NUM!', 'The result is too large');
    const el = (x, i, j) => {
      if (!(x instanceof Rng)) return x;
      const ii = x.h === 1 ? 0 : i, jj = x.w === 1 ? 0 : j;
      return ii < x.h && jj < x.w ? x.at(ii, jj) : err('#N/A');
    };
    const rows = [];
    for (let i = 0; i < h; i += 1) {
      const row = [];
      for (let j = 0; j < w; j += 1) row.push(fn(...xs.map((x) => el(x, i, j))));
      rows.push(row);
    }
    return new Arr(rows);
  }

  function name(n, env) {
    const key = n.v.toLowerCase();
    if (env.lets?.has(key)) return env.lets.get(key);
    const nr = ctx.nameRef?.(n.v);
    if (nr) return nr.r1 === nr.r2 && nr.c1 === nr.c2 ? cellValue(nr.tab, nr.r1, nr.c1) : new Rng(eng, nr.tab, nr.r1, nr.c1, nr.r2, nr.c2);
    return err('#NAME?', `Unknown name ${n.v}`);
  }

  function node(n, env) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return err(n.v);
      case 'blank': return null;
      case 'name': return name(n, env);
      case 'ref': return ref(n.ref, env);
      case 'un': {
        const x = node(n.x, env);
        const f = (v) => { const y = toNum(v); return isErr(y) ? y : n.op === '-' ? -y : y; };
        return isMulti(x) ? broadcast([x], f) : f(scalar(x, env));
      }
      case 'pct': {
        const x = node(n.x, env);
        const f = (v) => { const y = toNum(v); return isErr(y) ? y : y / 100; };
        return isMulti(x) ? broadcast([x], f) : f(scalar(x, env));
      }
      case 'bin': {
        const a = node(n.a, env), b = node(n.b, env);
        if (isMulti(a) || isMulti(b)) return broadcast([a, b], (x, y) => binary(n.op, x, y));
        return binary(n.op, scalar(a, env), scalar(b, env));
      }
      case 'fn': return call(n, env);
      default: return err('#ERROR!');
    }
  }

  function call(n, env) {
    const arg = (i) => node(n.args[i] || { t: 'blank' }, env);
    // IF / IFERROR / IFNA work out only the branch they return (all of it over an array).
    if (n.name === 'IF') {
      const cond = arg(0);
      if (isMulti(cond)) {
        const yes = n.args[1] ? arg(1) : true, no = n.args[2] ? arg(2) : false;
        return broadcast([cond, yes, no], (c, y, z) => { const b = toBool(c); return isErr(b) ? b : b ? y ?? 0 : z ?? 0; });
      }
      const c = toBool(scalar(cond, env));
      if (isErr(c)) return c;
      const pick = c ? n.args[1] : n.args[2];
      if (!pick) return c ? 0 : false;
      const v = node(pick, env);
      return isMulti(v) ? v : scalar(v, env) ?? (pick.t === 'blank' ? 0 : null);
    }
    if (n.name === 'IFERROR' || n.name === 'IFNA') {
      const v0 = arg(0);
      const catches = (v) => isErr(v) && (n.name === 'IFERROR' || v.code === '#N/A');
      if (isMulti(v0)) { const alt = scalar(arg(1), env); return broadcast([v0], (v) => (catches(v) ? alt ?? '' : v)); }
      const v = scalar(v0, env);
      return catches(v) ? scalar(arg(1), env) ?? '' : v;
    }
    if (n.name === 'LET') {
      if (n.args.length < 3 || n.args.length % 2 === 0) return err('#VALUE!', 'LET needs names, values and a result');
      const inner = { ...env, lets: new Map(env.lets || []) };
      for (let i = 0; i + 1 < n.args.length; i += 2) {
        if (n.args[i].t !== 'name') return err('#VALUE!', 'LET names must be plain words');
        inner.lets.set(n.args[i].v.toLowerCase(), node(n.args[i + 1], inner));
      }
      return node(n.args[n.args.length - 1], inner);
    }
    if (n.name === 'ARRAYFORMULA') return arg(0);
    const f = FN[n.name];
    if (!f) return err('#NAME?', `Unknown function ${n.name}`);
    // A one-cell reference reaches a function as a range (ROW(B7), ISBLANK(D1), SUM ignoring text).
    const args = n.args.map((x) => (x.t === 'ref' ? ref(x.ref, env, true) : node(x, env)));
    try { return f(args, env, eng); } catch (e) { return isErr(e) ? e : err('#VALUE!'); }
  }

  const eng = {
    ctx, cellValue, scalar, vars: opts.vars || null,
    /** The value of the cell at (r, c) on the tab with this id. */
    value: (tabId, r, c) => { const tab = ctx.tabById(tabId); return tab ? cellValue(tab, r, c) : null; },
    /** Is (r, c) showing a value an array formula elsewhere spilled into it? */
    isSpilled: (tab, r, c) => !filled(ctx.cell(tab, r, c)) && cellValue(tab, r, c) != null,
    /** A formula's value as if it were typed into (r, c) on tabId (A1 text). */
    evalText: (text, tabId, r = 0, c = 0) => {
      const tab = ctx.tabById(tabId);
      const tree = parsed(text);
      if (!tab || !tree) return err('#ERROR!');
      const v = node(tree, { tab, r, c });
      return v instanceof Rng ? scalar(v, { tab, r, c }) : v;
    },
    /** INDIRECT: a reference written as text ("B2", "'Q3'!A1:C9", a name). */
    refText: (text, env) => {
      let toks;
      try { toks = tokenize(String(text).replace(/^=/, '')); } catch { return err('#REF!'); }
      if (toks.length !== 1) return err('#REF!', 'Not a reference');
      if (toks[0].type === 'ref') return ref(toks[0].value, env, true);
      if (toks[0].type === 'name') return name({ v: toks[0].value }, env);
      return err('#REF!', 'Not a reference');
    },
    rangeOn: (tab, r1, c1, r2, c2) => new Rng(eng, tab, r1, c1, r2, c2),
    /** The size of the array (r, c) spills, once it has been worked out - {h, w, blocked} or null. */
    spillOf: (tab, r, c) => { cellValue(tab, r, c); return spills.get(keyOf(tab, r, c)) || null; },
    rawCell: (tab, r, c) => ctx.cell(tab, r, c),
  };
  return eng;
}
