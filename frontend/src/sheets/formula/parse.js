// Sheets formulas: A1 text -> tokens -> a tree, and the stored form.
//
// A formula is SHOWN and TYPED as A1 text ("=SUM(B2:B9)*'Q3 Plan'!$C$1") but
// STORED with every reference written by the stable ids of its row, column
// and tab: @[tab!$row,col:row,col] (no tab = the formula's own tab, `*` = a
// whole row or column, `$` = absolute). Inserting or deleting rows and
// columns - by anyone, at the same time - therefore never moves what a
// formula points at; a reference whose row or column is gone reads #REF!.

export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const a1 = (r, c) => colName(c) + (r + 1);

const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d+)`;
const RE_CELLS = new RegExp(`(?:${SHEET})?${CELL}(?::${CELL})?`, 'y');
const RE_COLS = new RegExp(String.raw`(?:${SHEET})?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})`, 'y');
const RE_ROWS = new RegExp(String.raw`(?:${SHEET})?(\$?)(\d+):(\$?)(\d+)`, 'y');
const RE_NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const RE_ERR = /#(?:REF!|DIV\/0!|N\/A|NAME\?|VALUE!|NUM!|NULL!|ERROR!)/y;
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_.]*/y;
const OPS = ['<>', '<=', '>=', '<', '>', '=', '+', '-', '*', '/', '^', '&', '%'];
const MAX_ROWS = 1048576, MAX_COLS = 18278;   // A1 limits (XFD = 16384, but ZZZ fits 3 letters)

const at = (re, s, i) => { re.lastIndex = i; return re.exec(s); };
const sheetOf = (m) => (m[1] != null ? m[1].replace(/''/g, "'") : m[2] ?? null);
const nextIsWord = (s, i) => /[A-Za-z0-9_.(!]/.test(s[i] || '');

/** Tokens of A1 formula text (without the leading '='). Throws SyntaxError. */
export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    let m;
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= src.length) throw new SyntaxError('Unclosed text');
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += src[j]; j += 1;
      }
      out.push({ type: 'str', value: v, start: i, end: j + 1 }); i = j + 1; continue;
    }
    if ((m = at(RE_CELLS, src, i)) && !nextIsWord(src, i + m[0].length)) {
      const a = { ac: !!m[3], c: colIndex(m[4]), ar: !!m[5], r: +m[6] - 1 };
      const b = m[7] != null ? { ac: !!m[7], c: colIndex(m[8]), ar: !!m[9], r: +m[10] - 1 } : null;
      if (a.r < MAX_ROWS && a.c < MAX_COLS && (!b || (b.r < MAX_ROWS && b.c < MAX_COLS))) {
        out.push({ type: 'ref', value: { sheet: sheetOf(m), a, b }, start: i, end: i + m[0].length });
        i += m[0].length; continue;
      }
    }
    if ((m = at(RE_COLS, src, i)) && !nextIsWord(src, i + m[0].length)) {
      const a = { r: null, ar: false, ac: !!m[3], c: colIndex(m[4]) };
      const b = { r: null, ar: false, ac: !!m[5], c: colIndex(m[6]) };
      out.push({ type: 'ref', value: { sheet: sheetOf(m), a, b }, start: i, end: i + m[0].length });
      i += m[0].length; continue;
    }
    if ((m = at(RE_ROWS, src, i)) && !nextIsWord(src, i + m[0].length) && (m[1] != null || m[2] != null || !out.length || out[out.length - 1].type === 'op' || out[out.length - 1].type === '(' || out[out.length - 1].type === ',')) {
      const a = { c: null, ac: false, ar: !!m[3], r: +m[4] - 1 };
      const b = { c: null, ac: false, ar: !!m[5], r: +m[6] - 1 };
      out.push({ type: 'ref', value: { sheet: sheetOf(m), a, b }, start: i, end: i + m[0].length });
      i += m[0].length; continue;
    }
    if ((m = at(RE_NUM, src, i))) { out.push({ type: 'num', value: Number(m[0]), start: i, end: i + m[0].length }); i += m[0].length; continue; }
    if ((m = at(RE_ERR, src, i))) { out.push({ type: 'err', value: m[0], start: i, end: i + m[0].length }); i += m[0].length; continue; }
    if ((m = at(RE_IDENT, src, i))) {
      const word = m[0], end = i + word.length;
      let j = end; while (/\s/.test(src[j] || '')) j += 1;
      if (src[j] === '(') out.push({ type: 'func', value: word.toUpperCase(), start: i, end });
      else if (/^(TRUE|FALSE)$/i.test(word)) out.push({ type: 'bool', value: word.toUpperCase() === 'TRUE', start: i, end });
      else out.push({ type: 'name', value: word, start: i, end });
      i = end; continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') { out.push({ type: ch, start: i, end: i + 1 }); i += 1; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ type: 'op', value: op, start: i, end: i + op.length }); i += op.length; continue; }
    throw new SyntaxError(`Unexpected "${ch}"`);
  }
  return out;
}

/** A tree from A1 formula text (with or without the leading '='). Throws SyntaxError. */
export function parse(text) {
  const src = text[0] === '=' ? text.slice(1) : text;
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...ops) => peek()?.type === 'op' && ops.includes(peek().value);
  const expect = (type) => { if (peek()?.type !== type) throw new SyntaxError(`Expected ${type}`); return toks[p++]; };
  const bin = (next, ops) => () => {
    let a = next();
    while (isOp(...ops)) { const op = toks[p++].value; a = { t: 'bin', op, a, b: next() }; }
    return a;
  };
  const primary = () => {
    const tk = toks[p++];
    if (!tk) throw new SyntaxError('Formula ends early');
    switch (tk.type) {
      case 'num': return { t: 'num', v: tk.value };
      case 'str': return { t: 'str', v: tk.value };
      case 'bool': return { t: 'bool', v: tk.value };
      case 'err': return { t: 'err', v: tk.value };
      case 'ref': return { t: 'ref', ref: tk.value };
      case 'name': return { t: 'name', v: tk.value };
      case 'func': {
        expect('(');
        const args = [];
        if (peek()?.type === ')') { p += 1; return { t: 'fn', name: tk.value, args }; }
        for (;;) {
          if (peek()?.type === ',' || peek()?.type === ')') args.push({ t: 'blank' });
          else args.push(cmp());
          if (peek()?.type === ',') { p += 1; continue; }
          expect(')');
          return { t: 'fn', name: tk.value, args };
        }
      }
      case '(': { const e = cmp(); expect(')'); return e; }
      default: throw new SyntaxError('Unexpected token');
    }
  };
  const postfix = () => { let x = primary(); while (isOp('%')) { p += 1; x = { t: 'pct', x }; } return x; };
  const unary = () => (isOp('-', '+') ? { t: 'un', op: toks[p++].value, x: unary() } : postfix());
  const pow = bin(unary, ['^']);
  const mul = bin(pow, ['*', '/']);
  const add = bin(mul, ['+', '-']);
  const cat = bin(add, ['&']);
  const cmp = bin(cat, ['=', '<>', '<', '>', '<=', '>=']);
  if (!toks.length) throw new SyntaxError('Empty formula');
  const tree = cmp();
  if (p < toks.length) throw new SyntaxError('Unexpected text after the formula');
  return tree;
}

// ── the stored form ───────────────────────────────────────────────────────
const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
  ? name : `'${name.replace(/'/g, "''")}'`);

const partA1 = (p) => (p.c != null ? (p.ac ? '$' : '') + colName(p.c) : '') + (p.r != null ? (p.ar ? '$' : '') + (p.r + 1) : '');

/** A reference value (tokenize's) as A1 text. */
export function refA1(ref) {
  const pre = ref.sheet != null ? quoteSheet(ref.sheet) + '!' : '';
  return pre + partA1(ref.a) + (ref.b ? ':' + partA1(ref.b) : '');
}

/**
 * A1 formula text -> stored form. ctx.tab(idOrNull, name) finds a tab by
 * name; ctx.rowId(tab, i) / ctx.colId(tab, i) give (and may create) the id
 * at an index. A reference to a tab that does not exist becomes #REF!.
 * Throws SyntaxError for text that does not tokenize (stored as typed).
 */
export function encodeFormula(text, ctx, curTab) {
  const body = text.slice(1);
  const toks = tokenize(body);
  let out = '', last = 0;
  for (const tk of toks) {
    if (tk.type !== 'ref') continue;
    out += body.slice(last, tk.start);
    last = tk.end;
    const { sheet, a, b } = tk.value;
    const tab = sheet != null ? ctx.tabByName(sheet) : ctx.tabById(curTab);
    if (!tab) { out += '#REF!'; continue; }
    const enc = (q) => `${q.r == null ? '*' : (q.ar ? '$' : '') + ctx.rowId(tab, q.r)},${q.c == null ? '*' : (q.ac ? '$' : '') + ctx.colId(tab, q.c)}`;
    out += `@[${tab.id === curTab ? '' : tab.id + '!'}${enc(a)}${b ? ':' + enc(b) : ''}]`;
  }
  return '=' + out + body.slice(last);
}

const ENC_RE = /"(?:[^"]|"")*"|@\[([^\]]*)\]/g;
const PART_RE = /^(\$?)([A-Za-z0-9_-]+|\*),(\$?)([A-Za-z0-9_-]+|\*)$/;

/** Stored form -> A1 text, read against the current rows, columns and tab names. */
export function decodeFormula(stored, ctx, curTab) {
  if (!stored || stored.indexOf('@[') < 0) return stored;
  return stored.replace(ENC_RE, (whole, inner) => {
    if (inner == null) return whole;
    const bang = inner.indexOf('!');
    const tabId = bang >= 0 ? inner.slice(0, bang) : curTab;
    const tab = ctx.tabById(tabId);
    if (!tab) return '#REF!';
    const parts = (bang >= 0 ? inner.slice(bang + 1) : inner).split(':');
    const out = [];
    for (const part of parts) {
      const m = part.match(PART_RE);
      if (!m) return '#REF!';
      const r = m[2] === '*' ? null : ctx.rowIndex(tab, m[2]);
      const c = m[4] === '*' ? null : ctx.colIndex(tab, m[4]);
      if (r === -1 || c === -1) return '#REF!';
      out.push({ r, ar: !!m[1], c, ac: !!m[3] });
    }
    return refA1({ sheet: tab.id === curTab ? null : tab.name, a: out[0], b: out[1] || null });
  });
}

/**
 * A1 formula text with every relative part moved by dr rows and dc columns
 * (a copy, a paste, the fill handle). A part pushed off the sheet is #REF!.
 */
export function shiftFormula(text, dr, dc) {
  if (!dr && !dc) return text;
  let toks;
  try { toks = tokenize(text.slice(1)); } catch { return text; }
  const body = text.slice(1);
  let out = '', last = 0;
  for (const tk of toks) {
    if (tk.type !== 'ref') continue;
    out += body.slice(last, tk.start);
    last = tk.end;
    const mv = (q) => ({ ...q, r: q.r == null || q.ar ? q.r : q.r + dr, c: q.c == null || q.ac ? q.c : q.c + dc });
    const a = mv(tk.value.a), b = tk.value.b ? mv(tk.value.b) : null;
    const bad = [a, b].some((q) => q && ((q.r != null && q.r < 0) || (q.c != null && q.c < 0)));
    out += bad ? '#REF!' : refA1({ ...tk.value, a, b });
  }
  return '=' + out + body.slice(last);
}
