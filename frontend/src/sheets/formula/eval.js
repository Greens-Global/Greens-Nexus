// Sheets formulas: evaluating a workbook. Values are numbers, strings,
// booleans, null (blank) or an Err; a range argument is a Rng.
//
// shortcut: full recompute, upgrade to a dependency graph when sheets pass ~20k formulas.
// Every doc change builds a new engine (createEngine); values are worked out
// lazily, once each, as the grid or a dependent formula asks for them.
import { parse, decodeFormula } from './parse.js';
import { FN } from './functions.js';
import { Err, isErr, err, Rng, toNum, toStr, toBool, compare } from './values.js';

export { Err, isErr, err, Rng, toNum, toStr, toBool, compare };

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

/**
 * ctx: { tabById(id), tabByName(name), rowIndex(tab, id), colIndex(tab, id), cell(tab, r, c) }
 * tabs are { id, name, rows: [ids], cols: [ids] }.
 */
export function createEngine(ctx) {
  const memo = new Map();
  const busy = new Set();

  function cellValue(tab, r, c) {
    const cell = ctx.cell(tab, r, c);
    if (!cell) return null;
    if (cell.f == null) return cell.v ?? null;
    const key = `${tab.id}|${r}|${c}`;
    if (memo.has(key)) return memo.get(key);
    if (busy.has(key)) return err('#REF!', 'Circular dependency');
    busy.add(key);
    let v;
    try { v = evalFormula(cell.f, { tab, r, c }); } finally { busy.delete(key); }
    memo.set(key, v);
    return v;
  }

  function evalFormula(stored, env) {
    const text = decodeFormula(stored, ctx, env.tab.id);
    const tree = parsed(text);
    if (!tree) return err('#ERROR!', 'The formula could not be read');
    let v = node(tree, env);
    if (v instanceof Rng) v = scalar(v, env);
    if (typeof v === 'number' && !Number.isFinite(v)) return err('#NUM!');
    return v === undefined ? null : v;
  }

  function scalar(v, env) {
    if (!(v instanceof Rng)) return v;
    if (v.h === 1 && v.w === 1) return v.at(0, 0);
    if (v.w === 1 && env.r >= v.r1 && env.r <= v.r2 && v.tab === env.tab) return v.at(env.r - v.r1, 0);
    if (v.h === 1 && env.c >= v.c1 && env.c <= v.c2 && v.tab === env.tab) return v.at(0, env.c - v.c1);
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

  function node(n, env) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return err(n.v);
      case 'blank': return null;
      case 'name': return err('#NAME?', `Unknown name ${n.v}`);
      case 'ref': return ref(n.ref, env);
      case 'un': {
        const x = toNum(scalar(node(n.x, env), env));
        return isErr(x) ? x : n.op === '-' ? -x : x;
      }
      case 'pct': { const x = toNum(scalar(node(n.x, env), env)); return isErr(x) ? x : x / 100; }
      case 'bin': {
        const a = scalar(node(n.a, env), env);
        if (isErr(a)) return a;
        const b = scalar(node(n.b, env), env);
        if (isErr(b)) return b;
        if (n.op === '&') return toStr(a) + toStr(b);
        if ('+-*/^'.includes(n.op)) return arith(n.op, a, b);
        const c = compare(a, b);
        switch (n.op) {
          case '=': return c === 0;
          case '<>': return c !== 0;
          case '<': return c < 0;
          case '>': return c > 0;
          case '<=': return c <= 0;
          default: return c >= 0;
        }
      }
      case 'fn': {
        // IF / IFERROR / IFNA work out only the branch they return.
        if (n.name === 'IF') {
          const c = toBool(scalar(node(n.args[0] || { t: 'blank' }, env), env));
          if (isErr(c)) return c;
          const pick = c ? n.args[1] : n.args[2];
          return pick ? scalar(node(pick, env), env) ?? (pick.t === 'blank' ? 0 : null) : (c ? 0 : false);
        }
        if (n.name === 'IFERROR' || n.name === 'IFNA') {
          const v = scalar(node(n.args[0] || { t: 'blank' }, env), env);
          const caught = isErr(v) && (n.name === 'IFERROR' || v.code === '#N/A');
          return caught ? scalar(node(n.args[1] || { t: 'blank' }, env), env) ?? '' : v;
        }
        const f = FN[n.name];
        if (!f || n.name.startsWith('__')) return err('#NAME?', `Unknown function ${n.name}`);
        // A one-cell reference reaches a function as a range (ROW(B7), ISBLANK(D1), SUM ignoring text).
        const args = n.args.map((x) => (x.t === 'ref' ? ref(x.ref, env, true) : node(x, env)));
        try { return f(args, env, eng); } catch (e) { return isErr(e) ? e : err('#VALUE!'); }
      }
      default: return err('#ERROR!');
    }
  }

  const eng = {
    ctx, cellValue, scalar,
    /** The value of the cell at (r, c) on the tab with this id. */
    value: (tabId, r, c) => { const tab = ctx.tabById(tabId); return tab ? cellValue(tab, r, c) : null; },
    /** A formula's value as if it were typed into (r, c) on tabId (A1 text). */
    evalText: (text, tabId, r = 0, c = 0) => {
      const tab = ctx.tabById(tabId);
      const tree = parsed(text);
      if (!tab || !tree) return err('#ERROR!');
      const v = node(tree, { tab, r, c });
      return v instanceof Rng ? scalar(v, { tab, r, c }) : v;
    },
  };
  return eng;
}
