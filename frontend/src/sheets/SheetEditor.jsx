// Sheets: the workbook on screen - toolbar and menus, name box and formula
// bar, the grid and the tab strip - drawn from the shared document it is given.
//
// The grid is virtualized: only the rows and columns in view are drawn, at
// their real offsets inside one scrolling canvas. The header row (with any
// frozen rows) is a band stuck to the top, the row numbers (with any frozen
// columns) a band stuck to the left, the corner both. Every cell draws its
// own selection, fill-handle and other people's selection edges, so the
// frozen bands need no overlay of their own. A merged block is drawn once, by
// its top-left cell, at the block's size; a hidden row or column is 0 px.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Undo2, Redo2, Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, WrapText,
  Baseline, PaintBucket, ArrowDownAZ, ArrowUpZA, Search, ChevronUp, ChevronDown, X, Plus, MoreVertical,
  FileUp, FileDown, Snowflake, Filter, Combine, Grid3x3, Link2, Variable, ChevronDown as Caret, CheckSquare, Square,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, BarChart3, StickyNote, Keyboard,
} from 'lucide-react';
import { Menu, SmallBtn, ColorGrid, THEME_COLORS, STANDARD_COLORS, useDismiss } from '../components/docRibbon/ui';
import { dialog } from '../ui/dialog';
import {
  ROW_H, COL_W, buildCtx, writeCells, styleRange, styleCells, clearRange, insertLines, deleteLines, setSize, setTabMeta,
  addTab, duplicateTab, deleteTab, moveTab, loadSnapshot, blockAt, undoManagerFor, formulaText,
  setExtra, setExtras, setName, rangeIds, newId, safeLink, okName, FONTS, change, cellsOf, extraOf, LIMITS, AREA_MAX, MAX_TABS,
} from './model.js';
import { maxOf } from './formula/values.js';
import { a1, colName, colIndex, tokenize, encodeFormula, decodeFormula, refA1, shiftFormula } from './formula/parse.js';
import { createEngine, isErr, compare } from './formula/eval.js';
import { SIGS } from './formula/functions.js';
import { formatValue, parseInput, editText, NUMBER_FORMATS, DEFAULT_DECIMALS, usDate, usTime, serialFromDate } from './format.js';
import { parseTSV, toTSV, toHTML, parseHTMLTable } from './clipboard.js';
import { importSheetFile, exportSheetFile } from './io.js';
import {
  mergesOf, mergeAt, expandRect, filterRect, hiddenRows, filteredOut, hiddenCols, conditionalStyler, validationAt, listItems,
  validValue, ruleWords, seriesNext, chartData, cycleRef, autoSum, findIn, replaceIn, splitText, fillTokens, shownText,
} from './features.js';
import { ChartBox } from './charts.jsx';
import {
  ShortcutsPanel, FormatPanel, ConditionalPanel, ValidationPanel, NamesPanel, SortPanel, DedupePanel, SplitPanel,
  FilterPop, ListPick, NoteEditor, VariablePicker,
} from './panels.jsx';
import { keyId, isMac } from './shortcuts.js';
import './sheets.css';

const RH = 46;          // row number column
const CH = 24;          // column letter row
const REMOTE = 'nx-remote';
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_ROWS = [THEME_COLORS.map((h) => [h]), STANDARD_COLORS.map((h) => [h])];
const ZOOMS = [50, 75, 90, 100, 125, 150, 200];
const BORDER_CSS = { thin: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted' };
const borderCss = (spec) => { if (!spec) return undefined; const [w, color] = spec.split(' '); return `${BORDER_CSS[w] || '1px solid'} ${COLOR_RE.test(color) ? color : '#000'}`; };
const MOD = isMac ? 'Cmd' : 'Ctrl';

/** Largest i with off[i] <= y, within 0..n-1. */
function idxAt(off, y) {
  let lo = 0, hi = off.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (off[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}
const norm = (s) => ({ r1: Math.min(s.r, s.r2), r2: Math.max(s.r, s.r2), c1: Math.min(s.c, s.c2), c2: Math.max(s.c, s.c2) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const filledCell = (x) => !!x && (x.f != null || (x.v != null && x.v !== ''));

/** "B3" or "A1:C9" -> a selection, or null. */
function parseA1(text) {
  const m = String(text).trim().toUpperCase().match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/);
  if (!m) return null;
  const r = +m[2] - 1, c = colIndex(m[1]);
  return m[3] ? { r, c, r2: +m[4] - 1, c2: colIndex(m[3]) } : { r, c, r2: r, c2: c };
}

/** The function the caret is inside, for the signature hint. */
function openFunction(text) {
  const stack = [];
  let word = '', inStr = false;
  for (const ch of text) {
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; word = ''; continue; }
    if (/[A-Za-z0-9_.]/.test(ch)) { word += ch; continue; }
    if (ch === '(') stack.push(word.toUpperCase());
    else if (ch === ')') stack.pop();
    word = '';
  }
  return stack.length ? stack[stack.length - 1] : '';
}

/** A small menu at a point on screen (right-click, the tab menu, Ctrl+-). */
function PopMenu({ at, items, onClose, children }) {
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const style = { position: 'fixed', left: clamp(at.x, 8, window.innerWidth - 230), zIndex: 1000, maxHeight: '70vh', overflowY: 'auto' };
  if (at.up) style.bottom = window.innerHeight - at.y; else style.top = clamp(at.y, 8, window.innerHeight - 40);
  return (
    <div ref={ref} className="doc-ribbon-panel nxs-pop" style={style} role="menu">
      {items.map((it, i) => (it === '-' ? <div key={i} className="doc-ribbon-sep" /> : (
        <button key={it.label} type="button" role="menuitem" className="doc-ribbon-item" disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}>
          {it.icon && <it.icon size={14} />}<span>{it.label}</span>
        </button>
      )))}
      {children}
    </div>
  );
}

// `me` is who you are ({email, name, color}): presence comes from the host,
// notes are signed with it.
export default function SheetEditor({ doc, awareness = null, canEdit = true, me = null, title = '', onChange, toastErr, variables = [], variableValues = {} }) {
  const scroller = useRef(null);
  const editEl = useRef(null);       // the cell editor or the formula bar, whichever has the caret
  const fileRef = useRef(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // ── the document ────────────────────────────────────────────────────
  const [ver, setVer] = useState(0);
  const umRef = useRef(null);
  const [stacks, setStacks] = useState({ undo: 0, redo: 0 });
  useEffect(() => {
    const u = undoManagerFor(doc);
    umRef.current = u.um;
    const st = () => setStacks({ undo: u.um.undoStack.length, redo: u.um.redoStack.length });
    for (const ev of ['stack-item-added', 'stack-item-popped', 'stack-cleared']) u.um.on(ev, st);
    const f = (_update, origin) => {
      setVer((v) => v + 1);
      if (origin !== REMOTE) onChangeRef.current?.();
    };
    doc.on('update', f);
    return () => { doc.off('update', f); u.destroy(); umRef.current = null; };
  }, [doc]);
  const ctx = useMemo(() => buildCtx(doc), [doc, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = useMemo(() => ({ tokens: new Set((variables || []).map((v) => v?.token).filter(Boolean)), values: variableValues || {} }), [variables, variableValues]);
  const eng = useMemo(() => createEngine(ctx, { vars }), [ctx, vars]);
  const [tabId, setTabId] = useState('');
  const tab = ctx.tabById(tabId) || ctx.tabs[0];
  const R = tab.rows.length, C = tab.cols.length;
  const fr = Math.min(tab.frozenRows, R - 1), fc = Math.min(tab.frozenCols, C - 1);
  const merges = mergesOf(ctx, tab);
  const hidR = useMemo(() => hiddenRows(ctx, eng, tab), [ctx, eng, tab]);
  const hidC = useMemo(() => hiddenCols(ctx, tab), [ctx, tab]);
  // Rows the filter hides: Delete, fill, paste, formats and links pass over them, as in Excel.
  const filtHid = useMemo(() => filteredOut(ctx, eng, tab), [ctx, eng, tab]);
  const styler = useMemo(() => conditionalStyler(ctx, eng, tab), [ctx, eng, tab]);
  const filt = useMemo(() => filterRect(ctx, tab), [ctx, tab]);

  // ── view state ──────────────────────────────────────────────────────
  const [selRaw, setSel] = useState({ r: 0, c: 0, r2: 0, c2: 0 });
  const sel = { r: clamp(selRaw.r, 0, R - 1), c: clamp(selRaw.c, 0, C - 1), r2: clamp(selRaw.r2, 0, R - 1), c2: clamp(selRaw.c2, 0, C - 1) };
  const b = expandRect(merges, norm(sel));
  const [edit, setEdit] = useState(null);       // { r, c, text, mode: 'enter' | 'edit', from: 'cell' | 'bar' }
  const [pick, setPick] = useState(0);          // highlighted autocomplete row
  const [menu, setMenu] = useState(null);       // { x, y, kind, up? }
  const [find, setFind] = useState(null);       // { q, rep, i, replace, mc, whole }
  const [fillTo, setFillTo] = useState(null);
  const [renaming, setRenaming] = useState('');
  const [resize, setResize] = useState(null);   // { id, px } while a header edge is dragged
  const [panel, setPanel] = useState(null);     // 'shortcuts' | 'format' | 'cf' | 'dv' | 'dv-check' | 'names' | 'sort' | 'dedupe' | 'split'
  const [pop, setPop] = useState(null);         // { kind: 'filter' | 'list' | 'note' | 'vars', at, ... }
  const [showFormulas, setShowFormulas] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [chartSel, setChartSel] = useState('');
  const z = zoom / 100;
  const dragRef = useRef(null);
  const clipRef = useRef(null);

  const cellAt = (r, c) => ctx.cell(tab, r, c);
  const textOf = (r, c) => {
    const cell = cellAt(r, c);
    if (!cell) return '';
    return cell.f ? formulaText(ctx, tab.id, cell.f) : editText(cell.v, cell.s);
  };
  const shown = (r, c) => {
    const cell = cellAt(r, c);
    const v = eng.cellValue(tab, r, c);
    const t = formatValue(v, cell?.s);
    return fillTokens(t, variableValues)?.text ?? t;
  };
  const focusGrid = () => scroller.current?.focus({ preventScroll: true });
  const myName = me?.name || me?.email || (awareness?.getLocalState?.()?.user?.name) || 'Someone';

  // ── geometry ────────────────────────────────────────────────────────
  const geo = useMemo(() => {
    const rowY = new Float64Array(R + 1), colX = new Float64Array(C + 1);
    for (let i = 0; i < R; i += 1) rowY[i + 1] = rowY[i] + (hidR.has(i) ? 0 : resize?.id === tab.rows[i] ? resize.px : ctx.size(tab, tab.rows[i], ROW_H));
    for (let j = 0; j < C; j += 1) colX[j + 1] = colX[j] + (hidC.has(j) ? 0 : resize?.id === tab.cols[j] ? resize.px : ctx.size(tab, tab.cols[j], COL_W));
    return { rowY, colX };
  }, [ctx, tab, R, C, resize, hidR, hidC]);
  const { rowY, colX } = geo;
  const frozenH = rowY[fr], frozenW = colX[fc];
  const ADD_ROWS_H = canEdit ? 52 : 0;
  const totalW = RH + colX[C], totalH = CH + rowY[R] + ADD_ROWS_H;

  const [vp, setVp] = useState({ w: 1000, h: 520, top: 0, left: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setVp((v) => ({ ...v, w: el.clientWidth || v.w, h: el.clientHeight || v.h }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rafRef = useRef(0);
  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scroller.current;
      if (el) setVp((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
    });
  };
  // Scroll offsets are in zoomed pixels; the layout is not.
  const vTop = vp.top / z, vLeft = vp.left / z, vH = vp.h / z, vW = vp.w / z;
  const rA = Math.max(fr, idxAt(rowY, vTop + frozenH)), rB = Math.min(R - 1, idxAt(rowY, vTop + vH - CH) + 1);
  const cA = Math.max(fc, idxAt(colX, vLeft + frozenW)), cB = Math.min(C - 1, idxAt(colX, vLeft + vW - RH) + 1);

  const ensureVisible = useCallback((r, c) => {
    const el = scroller.current;
    if (!el) return;
    if (r >= fr) {
      const top = rowY[r] * z, bot = rowY[r + 1] * z, viewH = el.clientHeight - CH * z;
      if (top < el.scrollTop + frozenH * z) el.scrollTop = top - frozenH * z;
      else if (bot > el.scrollTop + viewH) el.scrollTop = bot - viewH;
    }
    if (c >= fc) {
      const l = colX[c] * z, rr = colX[c + 1] * z, viewW = el.clientWidth - RH * z;
      if (l < el.scrollLeft + frozenW * z) el.scrollLeft = l - frozenW * z;
      else if (rr > el.scrollLeft + viewW) el.scrollLeft = rr - viewW;
    }
  }, [rowY, colX, fr, fc, frozenH, frozenW, z]);

  const select = (next, scroll = true) => {
    setSel(next);
    setChartSel('');
    if (scroll) requestAnimationFrame(() => ensureVisible(next.r2, next.c2));
  };
  /** Where a cell is on screen (for a popover next to it). */
  const cellScreen = (r, c) => {
    const el = scroller.current?.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    const rect = el?.getBoundingClientRect?.();
    if (rect && rect.width) return { x: rect.left, y: rect.bottom + 4, rect };
    const s = scroller.current?.getBoundingClientRect?.() || { left: 40, top: 120 };
    return { x: s.left + 60, y: s.top + 60 };
  };

  // ── presence ────────────────────────────────────────────────────────
  const [remote, setRemote] = useState([]);
  useEffect(() => {
    if (!awareness) return undefined;
    const f = () => {
      const out = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID) return;
        const s = st?.sel, u = st?.user;
        if (!s || typeof s !== 'object' || ['tab', 'r', 'c', 'r2', 'c2'].some((k) => typeof s[k] !== 'string')) return;
        out.push({ id, ...s, name: String(u?.name || u?.email || 'Someone').slice(0, 40), color: COLOR_RE.test(u?.color || '') ? u.color : '#64748b' });
      });
      setRemote(out);
    };
    f();
    awareness.on('change', f);
    return () => awareness.off('change', f);
  }, [awareness]);
  const remoteBoxes = useMemo(() => remote.filter((x) => x.tab === tab.id).map((x) => {
    const r = ctx.rowIndex(tab, x.r), c = ctx.colIndex(tab, x.c), r2 = ctx.rowIndex(tab, x.r2), c2 = ctx.colIndex(tab, x.c2);
    if ([r, c, r2, c2].some((v) => v < 0)) return null;
    return { ...norm({ r, c, r2, c2 }), ar: r, ac: c, name: x.name, color: x.color, id: x.id };
  }).filter(Boolean), [remote, ctx, tab]);
  const selKey = `${tab.id}|${tab.rows[sel.r]}|${tab.cols[sel.c]}|${tab.rows[sel.r2]}|${tab.cols[sel.c2]}`;
  useEffect(() => {
    if (!awareness) return undefined;
    const t = setTimeout(() => {
      const [tb, r, c, r2, c2] = selKey.split('|');
      try { awareness.setLocalStateField('sel', { tab: tb, r, c, r2, c2 }); } catch { /* the session is closing */ }
    }, 50);
    return () => clearTimeout(t);
  }, [awareness, selKey]);

  // ── ranges written as text (panels, names) ─────────────────────────
  const a1Of = (t, rect) => {
    const pre = t.id === tab.id ? '' : (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t.name) ? t.name : `'${t.name.replace(/'/g, "''")}'`) + '!';
    return pre + (rect.r1 === rect.r2 && rect.c1 === rect.c2 ? a1(rect.r1, rect.c1) : `${a1(rect.r1, rect.c1)}:${a1(rect.r2, rect.c2)}`);
  };
  /** "B2:C9", "'Q3'!A1:A5", "B:B" or a name -> { tab, rect } on the current sheet's tabs, or null. */
  const rangeFrom = (text) => {
    let toks;
    try { toks = tokenize(String(text).trim().replace(/^=/, '')); } catch { return null; }
    if (toks.length !== 1) return null;
    if (toks[0].type === 'name') { const n = ctx.nameRef(toks[0].value); return n ? { tab: n.tab, rect: { r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2 } } : null; }
    if (toks[0].type !== 'ref') return null;
    const { sheet, a, b: bb } = toks[0].value;
    const t = sheet != null ? ctx.tabByName(sheet) : tab;
    if (!t) return null;
    const e2 = bb || a;
    const rect = { r1: a.r ?? 0, c1: a.c ?? 0, r2: e2.r ?? t.rows.length - 1, c2: e2.c ?? t.cols.length - 1 };
    const out = { r1: Math.min(rect.r1, rect.r2), r2: Math.max(rect.r1, rect.r2), c1: Math.min(rect.c1, rect.c2), c2: Math.max(rect.c1, rect.c2) };
    if (out.r2 >= t.rows.length || out.c2 >= t.cols.length) return null;
    return { tab: t, rect: out };
  };
  const selA1 = a1Of(tab, b);

  // ── editing ─────────────────────────────────────────────────────────
  const startEdit = (text, mode, from = 'cell') => {
    if (!canEdit) return;
    setEdit({ r: sel.r, c: sel.c, text: text ?? textOf(sel.r, sel.c), mode, from });
    setPick(0);
  };
  /** Text typed for (r, c) -> the cell to write, or null when validation refuses it. */
  const entryFor = (r, c, text) => {
    const cur = cellAt(r, c);
    const p = parseInput(text, cur?.s?.nf);
    let s = cur?.s || null;
    if (p.nf && !s?.nf) s = { ...(s || {}), nf: p.nf, ...(p.d != null ? { d: p.d } : {}) };
    if (typeof p.v === 'string' && p.v.includes('\n') && !s?.wrap) s = { ...(s || {}), wrap: true };
    const rule = validationAt(ctx, tab, r, c);
    if (rule && !p.f && rule.reject !== false && !validValue(rule, p.v, eng, ctx, tab)) {
      toastErr?.(`${a1(r, c)} takes ${ruleWords(rule)}.`);
      return null;
    }
    return { r, c, v: p.v ?? null, f: p.f || null, s };
  };
  const commit = (dr = 0, dc = 0, all = false) => {
    if (!edit) return true;
    const { r, c, text } = edit;
    if (all) {
      // Ctrl+Enter: the entry into every selected cell, a formula re-aimed for each.
      const list = [];
      for (let rr = b.r1; rr <= b.r2; rr += 1) {
        for (let cc = b.c1; cc <= b.c2; cc += 1) {
          if (hidR.has(rr)) continue;
          const t = text.startsWith('=') ? shiftFormula(text, rr - r, cc - c) : text;
          const e = entryFor(rr, cc, t);
          if (!e) return false;
          list.push(e);
        }
      }
      write(list);
    } else if (text !== textOf(r, c)) {
      const e = entryFor(r, c, text);
      if (!e) return false;
      writeCells(doc, tab.id, [e]);
    }
    setEdit(null);
    if (dr || dc) { const p = step(r, c, dr, dc); select({ r: p.r, c: p.c, r2: p.r, c2: p.c }); }
    focusGrid();
    return true;
  };
  const cancel = () => { setEdit(null); focusGrid(); };

  const word = edit && edit.text.startsWith('=') ? (edit.text.match(/(?:^=|[^A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]*)$/) || [])[1] : '';
  const suggestions = word ? Object.keys(SIGS).filter((n) => n.startsWith(word.toUpperCase()) && n !== word.toUpperCase()).slice(0, 6) : [];
  const hint = edit && edit.text.startsWith('=') ? SIGS[openFunction(edit.text)] : '';
  const accept = (name) => {
    setEdit((e) => ({ ...e, text: e.text.replace(/([A-Za-z][A-Za-z0-9.]*)$/, name + '(') }));
    setPick(0);
  };
  /** Put text at the caret of whichever editor is open. */
  const insertAtCaret = (str) => {
    const el = editEl.current;
    setEdit((e) => {
      if (!e) return e;
      const s = el?.selectionStart ?? e.text.length, en = el?.selectionEnd ?? e.text.length;
      const text = e.text.slice(0, s) + str + e.text.slice(en);
      requestAnimationFrame(() => { try { el?.setSelectionRange(s + str.length, s + str.length); } catch { /* gone */ } });
      return { ...e, text };
    });
  };

  const editKey = (e) => {
    e.stopPropagation();
    editEl.current = e.currentTarget;
    const id = keyId(e);
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
      return;
    }
    if (suggestions.length && e.key === 'Tab') { e.preventDefault(); accept(suggestions[pick] || suggestions[0]); return; }
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); insertAtCaret('\n'); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(0, 0, true); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); return; }
    if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'F4') {
      e.preventDefault();
      const el = e.currentTarget;
      const out = cycleRef(edit.text, el.selectionStart ?? edit.text.length);
      if (out) { setEdit({ ...edit, text: out.text }); requestAnimationFrame(() => { try { el.setSelectionRange(out.caret, out.caret); } catch { /* gone */ } }); }
      return;
    }
    if (id === 'Mod+Semicolon') { e.preventDefault(); insertAtCaret(usDate(serialFromDate(new Date()))); return; }
    if (id === 'Mod+Shift+Semicolon') { e.preventDefault(); insertAtCaret(usTime(serialFromDate(new Date()))); return; }
    if (edit?.mode === 'enter' && edit.from === 'cell' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      commit(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    }
  };

  // ── moving ──────────────────────────────────────────────────────────
  /** One step from (r, c): out of a merge from its far side, over hidden rows and columns, onto a merge's corner. */
  function step(r, c, dr, dc) {
    const m = mergeAt(merges, r, c);
    if (m) { if (dr > 0) r = m.r2; if (dr < 0) r = m.r1; if (dc > 0) c = m.c2; if (dc < 0) c = m.c1; }
    let nr = r + dr, nc = c + dc;
    while (dr && hidR.has(nr) && nr > 0 && nr < R - 1) nr += dr;
    while (dc && hidC.has(nc) && nc > 0 && nc < C - 1) nc += dc;
    nr = clamp(nr, 0, R - 1); nc = clamp(nc, 0, C - 1);
    const m2 = mergeAt(merges, nr, nc);
    return m2 ? { r: m2.r1, c: m2.c1 } : { r: nr, c: nc };
  }
  const edgeFrom = (r, c, dr, dc) => {
    const filled = (rr, cc) => filledCell(cellAt(rr, cc));
    let rr = r, cc = c;
    const inside = (a, b2) => a >= 0 && a < R && b2 >= 0 && b2 < C;
    if (!inside(rr + dr, cc + dc)) return { r: rr, c: cc };
    if (filled(rr, cc) && filled(rr + dr, cc + dc)) {
      while (inside(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) { rr += dr; cc += dc; }
      return { r: rr, c: cc };
    }
    rr += dr; cc += dc;
    while (inside(rr, cc) && !filled(rr, cc)) { if (!inside(rr + dr, cc + dc)) return { r: rr, c: cc }; rr += dr; cc += dc; }
    return { r: rr, c: cc };
  };
  const usedExtent = () => {
    let r = -1, c = -1;
    tab.cells.forEach((cell, k) => {
      if (!filledCell(cell)) return;
      const [ri, ci] = k.split('.');
      r = Math.max(r, ctx.rowIndex(tab, ri)); c = Math.max(c, ctx.colIndex(tab, ci));
    });
    return { r, c };
  };

  // ── changes ─────────────────────────────────────────────────────────
  const guard = () => { if (!canEdit) return false; if (edit) return commit(); return true; };
  const active = cellAt(sel.r, sel.c);
  /** Say so when the workbook's cell limit stopped part of a change. */
  const full = (skipped) => { if (skipped) toastErr?.(`A sheet holds 500,000 cells at most; ${skipped} ${skipped === 1 ? 'cell was' : 'cells were'} left out.`); };
  const areaOf = (rect) => (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
  const tooBig = (rect) => {
    if (areaOf(rect) <= AREA_MAX) return false;
    toastErr?.('Select fewer cells - 100,000 at most - to change them at once.');
    return true;
  };
  const write = (list) => full(writeCells(doc, tab.id, filtHid.size ? list.filter((x) => !filtHid.has(x.r)) : list));
  const applyStyle = (patch) => {
    if (!guard()) return;
    // A range past AREA_MAX restyles only the cells that hold something (styleRange's rule).
    if (areaOf(b) > AREA_MAX) toastErr?.('That is a big selection: only the cells with something in them were formatted.');
    full(styleRange(doc, tab.id, b, patch, { skipRows: filtHid }));
  };
  const toggle = (k) => applyStyle({ [k]: !active?.s?.[k] });
  const numberFormat = (nf, d = null) => applyStyle({ nf: nf || null, d });
  const decimals = (delta) => {
    let nf = active?.s?.nf || '';
    if (['date', 'time', 'datetime', 'text'].includes(nf)) return;
    if (!nf) nf = 'number';
    const v = eng.cellValue(tab, sel.r, sel.c);
    const cur = Number.isInteger(active?.s?.d) ? active.s.d : (DEFAULT_DECIMALS[nf] ?? (typeof v === 'number' ? (String(v).split('.')[1] || '').length : 0));
    applyStyle({ nf, d: clamp(cur + delta, 0, 10) });
  };
  const borders = (kind, style = 'thin', color = '#000000') => {
    if (!guard() || tooBig(b)) return;
    const spec = `${style} ${color.toLowerCase()}`;
    const list = [];
    for (let r = b.r1; r <= b.r2; r += 1) {
      if (filtHid.has(r)) continue;
      for (let c = b.c1; c <= b.c2; c += 1) {
        const p = {};
        if (kind === 'none') Object.assign(p, { bt: null, bb: null, bl: null, br: null });
        if (kind === 'all') Object.assign(p, { bt: spec, bb: spec, bl: spec, br: spec });
        if ((kind === 'outer' || kind === 'top') && r === b.r1) p.bt = spec;
        if ((kind === 'outer' || kind === 'bottom') && r === b.r2) p.bb = spec;
        if ((kind === 'outer' || kind === 'left') && c === b.c1) p.bl = spec;
        if ((kind === 'outer' || kind === 'right') && c === b.c2) p.br = spec;
        if (kind === 'inner') { if (r < b.r2) p.bb = spec; if (c < b.c2) p.br = spec; }
        if (Object.keys(p).length) list.push({ r, c, patch: p });
      }
    }
    full(styleCells(doc, tab.id, list));
  };

  /**
   * Rewrite the rows of a block in a new order: dest row rect.r1 + i takes
   * source row from[i] (null = empty). A moved formula is re-aimed by how far
   * its row moved, exactly like a copy (blockAt), and notes travel with their cells.
   */
  const moveRows = (rect, from) => {
    const list = [];
    const notes = [];
    for (let i = 0; i <= rect.r2 - rect.r1; i += 1) {
      const dr = rect.r1 + i, sr = from[i];
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        const cell = sr == null ? null : cellAt(sr, c);
        if (sr === dr) continue;
        const f = cell?.f ? shiftFormula(formulaText(ctx, tab.id, cell.f), dr - sr, 0) : null;
        list.push({ r: dr, c, v: f ? null : cell?.v ?? null, f, s: cell?.s || null, l: cell?.l || null });
        const note = sr == null ? null : noteAt(sr, c);
        if (note || noteAt(dr, c)) notes.push(['notes', `${tab.rows[dr]}.${tab.cols[c]}`, note || null]);
      }
    }
    full(writeCells(doc, tab.id, list));
    if (notes.length) setExtras(doc, tab.id, notes);
  };

  /** Sort rows of a block by keys [{c, desc}]; rows the filter hides stay where they are. */
  const sortRows = (rect, keys) => {
    if (!guard() || rect.r2 <= rect.r1) return;
    const rows = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      if (filtHid.has(r)) continue;
      rows.push({ keys: keys.map((k) => eng.cellValue(tab, r, k.c)), r });
    }
    rows.sort((x, y) => {
      for (let i = 0; i < keys.length; i += 1) {
        const a = x.keys[i], bb = y.keys[i];
        const ba = a == null || a === '', bb2 = bb == null || bb === '';
        if (ba || bb2) { if (ba !== bb2) return ba ? 1 : -1; continue; }   // blanks always last
        const k = compare(isErr(a) ? a.code : a, isErr(bb) ? bb.code : bb);
        if (k) return keys[i].desc ? -k : k;
      }
      return x.r - y.r;
    });
    // The sorted rows go back into the visible slots, in order; hidden rows keep theirs.
    const from = [];
    for (let r = rect.r1, k = 0; r <= rect.r2; r += 1) from.push(filtHid.has(r) ? r : rows[k++].r);
    moveRows(rect, from);
  };
  const sortBy = (desc) => {
    const whole = b.r1 === b.r2;
    const ext = usedExtent();
    const rect = whole ? { r1: fr, r2: ext.r, c1: 0, c2: ext.c } : b;
    if (rect.r2 > rect.r1 && rect.c2 >= rect.c1) sortRows(rect, [{ c: sel.c, desc }]);
  };
  const lines = (axis, where) => {
    if (!guard()) return;
    const n = axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
    const start = axis === 'rows' ? b.r1 : b.c1, end = axis === 'rows' ? b.r2 : b.c2;
    if (where === 'delete') deleteLines(doc, tab.id, axis, start, n);
    else insertLines(doc, tab.id, axis, where === 'before' ? start : end + 1, n);
  };
  const hideLines = (axis, hide) => {
    if (!guard()) return;
    const list = [];
    const [lo, hi] = axis === 'rows' ? [b.r1, b.r2] : [b.c1, b.c2];
    // Unhiding takes in the neighbors too, so selecting the rows around a hidden one works.
    for (let i = hide ? lo : Math.max(0, lo - 1); i <= (hide ? hi : hi + 1); i += 1) {
      const id = axis === 'rows' ? tab.rows[i] : tab.cols[i];
      if (id) list.push(['hidden', id, hide ? true : null]);
    }
    if (hide && list.length >= (axis === 'rows' ? R : C)) { toastErr?.(`At least one ${axis === 'rows' ? 'row' : 'column'} stays visible.`); return; }
    setExtras(doc, tab.id, list);
  };
  const undo = () => { if (guard()) umRef.current?.undo(); };
  const redo = () => { if (guard()) umRef.current?.redo(); };

  // merges
  const mergeCells = async (how) => {
    if (!guard()) return;
    const list = [];
    for (const m of merges) if (!(m.r2 < b.r1 || m.r1 > b.r2 || m.c2 < b.c1 || m.c1 > b.c2)) list.push(['merges', `${tab.rows[m.r1]}.${tab.cols[m.c1]}`, null]);
    if (how === 'unmerge') { setExtras(doc, tab.id, list); return; }
    const blocks = how === 'rows'
      ? Array.from({ length: b.r2 - b.r1 + 1 }, (_, i) => ({ r1: b.r1 + i, r2: b.r1 + i, c1: b.c1, c2: b.c2 }))
      : [b];
    if (blocks.every((x) => x.r1 === x.r2 && x.c1 === x.c2)) return;
    if (tooBig(b)) return;
    if (merges.length - list.length + blocks.length > LIMITS.merges) { toastErr?.(`A tab holds ${LIMITS.merges.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} merged blocks at most.`); return; }
    let losing = false;
    for (const x of blocks) for (let r = x.r1; r <= x.r2; r += 1) for (let c = x.c1; c <= x.c2; c += 1) if ((r !== x.r1 || c !== x.c1) && filledCell(cellAt(r, c))) losing = true;
    if (losing && !(await dialog.confirm('Merging keeps only the top-left value of each block. The others are cleared.', { title: 'Merge Cells', confirmText: 'Merge' }))) return;
    change(doc, () => {
      const map = cellsOf(doc, tab.id), mm = extraOf(doc, 'merges', tab.id);
      for (const [, key] of list) mm.delete(key);
      for (const x of blocks) {
        if (x.r1 === x.r2 && x.c1 === x.c2) continue;
        for (let r = x.r1; r <= x.r2; r += 1) for (let c = x.c1; c <= x.c2; c += 1) {
          const key = `${tab.rows[r]}.${tab.cols[c]}`;
          if ((r !== x.r1 || c !== x.c1) && map.has(key)) { const cur = map.get(key); if (cur.s) map.set(key, { s: cur.s }); else map.delete(key); }
        }
        mm.set(`${tab.rows[x.r1]}.${tab.cols[x.c1]}`, { r2: tab.rows[x.r2], c2: tab.cols[x.c2] });
      }
    });
  };

  // filter
  const toggleFilter = () => {
    if (!guard()) return;
    if (tab.filter?.get('f')) { setExtra(doc, 'filter', tab.id, 'f', null); return; }
    const ext = usedExtent();
    const rect = b.r1 === b.r2 && b.c1 === b.c2 ? { r1: 0, c1: 0, r2: Math.max(0, ext.r), c2: Math.max(0, ext.c) } : b;
    setExtra(doc, 'filter', tab.id, 'f', { r: tab.rows[rect.r1], c1: tab.cols[rect.c1], c2: tab.cols[rect.c2], crit: {} });
  };
  const setFilterCrit = (c, crit) => {
    if (!guard() || !filt) return;
    const next = { ...(filt.crit || {}) };
    if (crit) next[tab.cols[c]] = crit; else delete next[tab.cols[c]];
    setExtra(doc, 'filter', tab.id, 'f', { ...filt.raw, crit: next });
  };
  const openFilter = (c, at) => {
    if (!filt) return;
    const counts = new Map();
    for (let r = filt.r + 1; r <= filt.last; r += 1) { const t = shownText(eng, ctx, tab, r, c); counts.set(t, (counts.get(t) || 0) + 1); }
    const values = [...counts.entries()].map(([text, count]) => ({ text, count })).sort((x, y) => compare(x.text, y.text));
    setPop({ kind: 'filter', at, c, values, crit: filt.crit[tab.cols[c]] || {}, title: shown(filt.r, c) || `Column ${colName(c)}` });
  };

  // notes, links, variables
  const noteKey = (r, c) => `${tab.rows[r]}.${tab.cols[c]}`;
  const noteAt = (r, c) => tab.notes?.get(noteKey(r, c)) || null;
  const openNote = () => { if (!canEdit) return; if (edit) commit(); setPop({ kind: 'note', at: cellScreen(sel.r, sel.c), r: sel.r, c: sel.c }); };
  const saveNote = (r, c, text) => {
    if (!canEdit) return;
    if (text && !noteAt(r, c) && (tab.notes?.size || 0) >= LIMITS.notes) { toastErr?.('A tab holds 20,000 notes at most.'); return; }
    setExtra(doc, 'notes', tab.id, noteKey(r, c), text ? { text: text.slice(0, 5000), by: String(myName).slice(0, 120), at: new Date().toISOString() } : null);
  };
  const askLink = async () => {
    if (!guard() || tooBig(b)) return;
    const cur = active?.l || '';
    const out = await dialog.prompt('Link address (http, https or mailto). Leave it empty to remove the link.', { title: 'Insert Link', defaultValue: cur || 'https://', confirmText: 'Save' });
    if (out == null) return;
    const url = out.trim() && out.trim() !== 'https://' ? safeLink(out) : '';
    if (out.trim() && out.trim() !== 'https://' && !url) { toastErr?.('Links start with http://, https:// or mailto:.'); return; }
    const list = [];
    for (let r = b.r1; r <= b.r2; r += 1) for (let c = b.c1; c <= b.c2; c += 1) {
      const cell = cellAt(r, c);
      // A link on an empty cell only for the first cell (it shows the address); others must already exist.
      if (!cell && !(url && r === b.r1 && c === b.c1)) continue;
      list.push({ r, c, v: cell?.f ? null : (cell?.v ?? (url && r === b.r1 && c === b.c1 ? url : null)), f: cell?.f ? formulaText(ctx, tab.id, cell.f) : null, l: url || null });
    }
    write(list);
  };
  const openLink = (url) => { const u = safeLink(url); if (u) window.open(u, '_blank', 'noopener,noreferrer'); };
  const pickVariable = (token) => {
    if (!canEdit) return;
    const call = `VAR("${String(token).replace(/"/g, '""')}")`;     // a quote inside a formula string is doubled
    if (edit) { insertAtCaret(edit.text.startsWith('=') ? call : `{{${token}}}`); return; }
    write([{ r: sel.r, c: sel.c, f: '=' + call }]);
  };

  // validation
  const toggleCheck = (r, c) => {
    if (!canEdit) return;
    const v = eng.cellValue(tab, r, c);
    writeCells(doc, tab.id, [{ r, c, v: v !== true, f: null }]);
  };
  const pickFromList = (r, c, value) => {
    if (!canEdit) return;
    const p = parseInput(value, cellAt(r, c)?.s?.nf);
    writeCells(doc, tab.id, [{ r, c, v: p.v ?? null, f: null }]);
  };

  // ── fill ────────────────────────────────────────────────────────────
  const fillArea = fillTo ? (() => {
    const out = { down: fillTo.r - b.r2, up: b.r1 - fillTo.r, right: fillTo.c - b.c2, left: b.c1 - fillTo.c };
    const dir = Object.entries(out).sort((x, y) => y[1] - x[1])[0];
    if (dir[1] <= 0) return null;
    const [d, n] = dir;
    if (d === 'down') return { r1: b.r2 + 1, r2: b.r2 + n, c1: b.c1, c2: b.c2, dir: d };
    if (d === 'up') return { r1: b.r1 - n, r2: b.r1 - 1, c1: b.c1, c2: b.c2, dir: d };
    if (d === 'right') return { r1: b.r1, r2: b.r2, c1: b.c2 + 1, c2: b.c2 + n, dir: d };
    return { r1: b.r1, r2: b.r2, c1: b.c1 - n, c2: b.c1 - 1, dir: d };
  })() : null;
  /** Fill area from the selection: a series where the cells make one, else copies with formulas re-aimed. */
  const doFill = (area, { series = true } = {}) => {
    if (!area || !guard() || tooBig(area)) return;
    const vertical = area.dir === 'down' || area.dir === 'up';
    const back = area.dir === 'up' || area.dir === 'left';
    const list = [];
    const [l1, l2] = vertical ? [b.c1, b.c2] : [b.r1, b.r2];
    const n = vertical ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
    const count = vertical ? area.r2 - area.r1 + 1 : area.c2 - area.c1 + 1;
    for (let lane = l1; lane <= l2; lane += 1) {
      const src = Array.from({ length: n }, (_, k) => (vertical ? { r: b.r1 + k, c: lane } : { r: lane, c: b.c1 + k }));
      const cells = src.map((p) => cellAt(p.r, p.c));
      const next = series ? seriesNext(cells, count, back) : null;
      for (let k = 0; k < count; k += 1) {
        // k counts away from the selection: down/right from its far edge, up/left from its near edge.
        const off = back ? -(k + 1) : k + 1;
        const r = vertical ? (back ? b.r1 + off : b.r2 + off) : lane;
        const c = vertical ? lane : (back ? b.c1 + off : b.c2 + off);
        const si = back ? (n - 1 - (k % n)) : k % n;
        const p = src[si], cell = cells[si];
        if (next) { list.push({ r, c, v: next[k], f: null, s: cell?.s || null }); continue; }
        const block = [[cell ? { v: cell.v, f: cell.f ? formulaText(ctx, tab.id, cell.f) : null, s: cell.s } : null]];
        list.push(...blockAt(block, r, c, r - p.r, c - p.c));
      }
    }
    write(list);
    select({ r: Math.min(b.r1, area.r1), c: Math.min(b.c1, area.c1), r2: Math.max(b.r2, area.r2), c2: Math.max(b.c2, area.c2) }, false);
  };
  /** Ctrl+D / Ctrl+R: the first row (column) of the selection copied over the rest. */
  const fillFromEdge = (dir) => {
    if (!guard()) return;
    const down = dir === 'down';
    const rect = (down ? b.r1 === b.r2 : b.c1 === b.c2) ? (down ? { ...b, r1: Math.max(0, b.r1 - 1) } : { ...b, c1: Math.max(0, b.c1 - 1) }) : b;
    if (tooBig(rect)) return;
    const list = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        if ((down && r === rect.r1) || (!down && c === rect.c1)) continue;
        const pr = down ? rect.r1 : r, pc = down ? c : rect.c1;
        const cell = cellAt(pr, pc);
        list.push(...blockAt([[cell ? { v: cell.v, f: cell.f ? formulaText(ctx, tab.id, cell.f) : null, s: cell.s } : null]], r, c, r - pr, c - pc));
      }
    }
    write(list);
  };

  // ── mouse ───────────────────────────────────────────────────────────
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d === 'fill') { setFillTo(null); doFill(fillArea); }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  });

  const startResize = (e, axis, i) => {
    e.preventDefault(); e.stopPropagation();
    if (!canEdit) return;
    const id = axis === 'col' ? tab.cols[i] : tab.rows[i];
    const start = axis === 'col' ? e.clientX : e.clientY;
    const base = axis === 'col' ? colX[i + 1] - colX[i] : rowY[i + 1] - rowY[i];
    let px = base;
    const move = (ev) => { px = Math.max(16, base + ((axis === 'col' ? ev.clientX : ev.clientY) - start) / z); setResize({ id, px }); };
    const done = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', done);
      setResize(null);
      if (px !== base) setSize(doc, tab.id, id, px);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', done);
  };

  const onMouseDown = (e) => {
    const t = e.target;
    if (t.closest('input, textarea, select')) return;
    if (t.closest('[data-chart]')) return;
    const rz = t.closest('[data-resize]');
    if (rz) { const [axis, i] = rz.dataset.resize.split(':'); startResize(e, axis, +i); return; }
    if (t.closest('[data-fill]')) { e.preventDefault(); dragRef.current = 'fill'; setFillTo(null); return; }
    if (t.closest('[data-add-rows]')) return;
    const fb = t.closest('[data-filter-col]');
    if (fb) { e.preventDefault(); e.stopPropagation(); const rect = fb.getBoundingClientRect(); openFilter(+fb.dataset.filterCol, { x: rect.left - 240, y: rect.bottom + 4 }); return; }
    const arrow = t.closest('[data-dv-arrow]');
    if (arrow && canEdit) {
      e.preventDefault();
      const [r, c] = arrow.dataset.dvArrow.split(':').map(Number);
      const rule = validationAt(ctx, tab, r, c);
      const rect = arrow.getBoundingClientRect();
      if (rule) setPop({ kind: 'list', at: { x: rect.left - 200, y: rect.bottom + 4 }, r, c, items: listItems(rule, eng, ctx, tab), current: shown(r, c) });
      select({ r, c, r2: r, c2: c }, false);
      return;
    }
    const chk = t.closest('[data-check]');
    if (chk && e.button === 0) {
      e.preventDefault();
      const [r, c] = chk.dataset.check.split(':').map(Number);
      if (edit) commit();
      select({ r, c, r2: r, c2: c }, false);
      toggleCheck(r, c);
      focusGrid();
      return;
    }
    const right = e.button === 2;
    const cellEl = t.closest('[data-r]');
    const colEl = t.closest('[data-col]');
    const rowEl = t.closest('[data-row]');
    const all = t.closest('[data-all]');
    if (!cellEl && !colEl && !rowEl && !all) return;
    e.preventDefault();
    if (edit && !commit()) return;
    focusGrid();
    if (all) { select({ r: 0, c: 0, r2: R - 1, c2: C - 1 }, false); return; }
    if (colEl) {
      const c = +colEl.dataset.col;
      if (right && c >= b.c1 && c <= b.c2 && b.r1 === 0 && b.r2 === R - 1) return;
      select(e.shiftKey ? { ...sel, r: 0, r2: R - 1, c2: c } : { r: 0, c, r2: R - 1, c2: c }, false);
      dragRef.current = 'cols';
      return;
    }
    if (rowEl) {
      const r = +rowEl.dataset.row;
      if (right && r >= b.r1 && r <= b.r2 && b.c1 === 0 && b.c2 === C - 1) return;
      select(e.shiftKey ? { ...sel, c: 0, c2: C - 1, r2: r } : { r, c: 0, r2: r, c2: C - 1 }, false);
      dragRef.current = 'rows';
      return;
    }
    const r = +cellEl.dataset.r, c = +cellEl.dataset.c;
    const link = cellAt(r, c)?.l;
    if (link && (e.ctrlKey || e.metaKey) && !right) { openLink(link); return; }
    if (right && r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) return;
    select(e.shiftKey ? { ...sel, r2: r, c2: c } : { r, c, r2: r, c2: c }, false);
    dragRef.current = 'cells';
  };
  const onMouseOver = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const t = e.target;
    if (d === 'cols') { const el = t.closest('[data-col]') || t.closest('[data-c]'); if (el) setSel((s) => ({ ...s, c2: +(el.dataset.col ?? el.dataset.c) })); return; }
    if (d === 'rows') { const el = t.closest('[data-row]') || t.closest('[data-r]'); if (el) setSel((s) => ({ ...s, r2: +(el.dataset.row ?? el.dataset.r) })); return; }
    const el = t.closest('[data-r]');
    if (!el) return;
    const r = +el.dataset.r, c = +el.dataset.c;
    if (d === 'cells') setSel((s) => ({ ...s, r2: r, c2: c }));
    else if (d === 'fill') setFillTo({ r, c });
  };
  const onDoubleClick = (e) => {
    if (e.target.closest('[data-r]') && !e.target.closest('input, textarea, [data-check], [data-dv-arrow]')) startEdit(undefined, 'edit');
  };
  const onContextMenu = (e) => {
    if (e.target.closest('input, textarea')) return;
    const kind = e.target.closest('[data-col]') ? 'col' : e.target.closest('[data-row]') ? 'row' : e.target.closest('[data-r]') ? 'cell' : '';
    if (!kind) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind });
  };

  // ── clipboard ───────────────────────────────────────────────────────
  const readBlock = (rect) => {
    const block = [], texts = [], html = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      const br = [], tr = [], hr = [];
      for (let c = rect.c1; c <= rect.c2; c += 1) {
        const cell = cellAt(r, c);
        const val = eng.cellValue(tab, r, c);
        br.push(cell ? { v: cell.v, f: cell.f ? formulaText(ctx, tab.id, cell.f) : null, s: cell.s, l: cell.l, val: isErr(val) ? val.code : val } : (val != null ? { val } : null));
        const t = shown(r, c);
        tr.push(t); hr.push({ text: t, s: cell?.s });
      }
      block.push(br); texts.push(tr); html.push(hr);
    }
    return { block, texts, html };
  };
  const copyBlock = (e, cut) => {
    if (e.target !== scroller.current) return;
    e.preventDefault();
    if (tooBig(b)) return;
    const { block, texts, html } = readBlock(b);
    const tsv = toTSV(texts);
    e.clipboardData.setData('text/plain', tsv);
    e.clipboardData.setData('text/html', toHTML(html));
    clipRef.current = { tsv, block, r1: b.r1, c1: b.c1, cut };
    if (cut && canEdit) clearRange(doc, tab.id, b, { formats: true, skipRows: filtHid });
  };
  /** Paste text at the selection; `mode` = values | formats | formulas | transpose for Paste Special. */
  const pasteText = (text, html, mode = '') => {
    if (!guard()) return;
    const clip = clipRef.current;
    const internal = clip && (text == null || (text || '').replace(/\r/g, '').replace(/\n$/, '') === clip.tsv);
    let list = [];
    let h, w;
    if (internal) {
      let block = clip.block;
      if (mode === 'transpose') block = (block[0] || []).map((_, j) => block.map((row) => row[j]));
      h = block.length; w = block[0].length;
      const tile = h === 1 && w === 1 && (b.r2 > b.r1 || b.c2 > b.c1);
      if (tile && tooBig(b)) return;
      const spots = tile ? Array.from({ length: (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1) }, (_, k) => [b.r1 + Math.floor(k / (b.c2 - b.c1 + 1)), b.c1 + (k % (b.c2 - b.c1 + 1))]) : [[b.r1, b.c1]];
      for (const [r0, c0] of spots) {
        block.forEach((row, i) => row.forEach((cell, j) => {
          const r = r0 + i, c = c0 + j;
          const cur = cellAt(r, c);
          const srcR = mode === 'transpose' ? clip.r1 + j : clip.r1 + i, srcC = mode === 'transpose' ? clip.c1 + i : clip.c1 + j;
          const f = cell?.f ? (clip.cut ? cell.f : shiftFormula(cell.f, r - srcR, c - srcC)) : null;
          if (mode === 'values') list.push({ r, c, v: cell?.val ?? null, f: null });
          else if (mode === 'formats') list.push({ r, c, v: cur?.v ?? null, f: cur?.f ? formulaText(ctx, tab.id, cur.f) : null, s: cell?.s || null });
          else if (mode === 'formulas') list.push({ r, c, v: cell?.v ?? null, f });
          else list.push({ r, c, v: cell?.v ?? null, f, s: cell?.s || null, l: cell?.l || null });
        }));
      }
      if (tile) { h = b.r2 - b.r1 + 1; w = b.c2 - b.c1 + 1; }
      if (clip.cut && !mode) clipRef.current = null;
    } else {
      let rows = text ? parseTSV(text) : html ? parseHTMLTable(html) : null;
      if (!rows || !rows.length) return;
      if (mode === 'transpose') rows = (rows[0] || []).map((_, j) => rows.map((row) => row[j] ?? ''));
      const single = rows.length === 1 && rows[0].length === 1;
      const area = single ? b : { r1: b.r1, c1: b.c1, r2: b.r1 + rows.length - 1, c2: b.c1 + maxOf(rows.map((x) => x.length), 1) - 1 };
      if (tooBig(area)) return;
      for (let r = area.r1; r <= area.r2; r += 1) {
        for (let c = area.c1; c <= area.c2; c += 1) {
          const raw = single ? rows[0][0] : rows[r - area.r1]?.[c - area.c1];
          if (raw == null) continue;
          const cur = r < R && c < C ? cellAt(r, c) : null;
          const p = parseInput(raw, cur?.s?.nf);
          if (mode === 'values' && p.f) { list.push({ r, c, v: raw, f: null }); continue; }
          const s = p.nf && !cur?.s?.nf ? { ...(cur?.s || {}), nf: p.nf, ...(p.d != null ? { d: p.d } : {}) } : undefined;
          list.push({ r, c, v: p.v ?? null, f: p.f || null, s });
        }
      }
      h = area.r2 - area.r1 + 1; w = area.c2 - area.c1 + 1;
    }
    write(list);
    select({ r: b.r1, c: b.c1, r2: b.r1 + h - 1, c2: b.c1 + w - 1 }, false);
  };
  const onPaste = (e) => {
    if (e.target !== scroller.current) return;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'));
  };
  const pasteSpecial = async (mode) => {
    if (clipRef.current) { pasteText(null, null, mode); return; }
    try { pasteText(await navigator.clipboard.readText(), '', mode); }
    catch { toastErr?.(`Copy cells in this sheet first, or press ${MOD}+V to paste.`); }
  };

  // ── find and replace ────────────────────────────────────────────────
  const matches = useMemo(() => {
    const q = (find?.q || '').trim();
    if (!q) return [];
    const opts = { matchCase: !!find?.mc, whole: !!find?.whole };
    const out = [];
    tab.cells.forEach((cell, k) => {
      const [ri, ci] = k.split('.');
      const r = ctx.rowIndex(tab, ri), c = ctx.colIndex(tab, ci);
      if (r < 0 || c < 0) return;
      if (findIn(formatValue(eng.cellValue(tab, r, c), cell.s), q, opts)) out.push({ r, c });
    });
    return out.sort((x, y) => x.r - y.r || x.c - y.c);
  }, [find?.q, find?.mc, find?.whole, tab, ctx, eng]);
  const findStep = (d) => {
    if (!matches.length) return;
    const i = ((find?.i ?? -1) + d + matches.length) % matches.length;
    setFind((f) => ({ ...f, i }));
    const m = matches[i];
    select({ r: m.r, c: m.c, r2: m.r, c2: m.c });
  };
  const replaceMatches = (all) => {
    if (!guard() || !find?.q) return;
    const opts = { matchCase: !!find.mc, whole: !!find.whole };
    const targets = all ? matches : matches[find.i] ? [matches[find.i]] : matches.slice(0, 1);
    const list = [];
    let skipped = 0;
    for (const m of targets) {
      const cell = cellAt(m.r, m.c);
      if (cell?.f) { skipped += 1; continue; }
      const p = parseInput(replaceIn(editText(cell?.v, cell?.s), find.q, find.rep || '', opts), cell?.s?.nf);
      list.push({ r: m.r, c: m.c, v: p.v ?? null, f: p.f || null });
    }
    if (list.length) write(list);
    if (skipped) toastErr?.(`${skipped} ${skipped === 1 ? 'cell has a formula' : 'cells have formulas'} and ${skipped === 1 ? 'was' : 'were'} left as is.`);
    if (!all) findStep(1);
  };

  // ── charts ──────────────────────────────────────────────────────────
  const insertChart = () => {
    if (!guard()) return;
    let rect = b;
    if (b.r1 === b.r2 && b.c1 === b.c2) { const ext = usedExtent(); if (ext.r < 0) { toastErr?.('Select the cells to chart first.'); return; } rect = { r1: 0, c1: 0, r2: ext.r, c2: ext.c }; }
    if ((tab.charts?.size || 0) >= LIMITS.charts) { toastErr?.(`A tab holds ${LIMITS.charts} charts at most.`); return; }
    const id = newId();
    setExtra(doc, 'charts', tab.id, id, {
      type: 'column', range: rangeIds(tab, rect), title: '',
      x: Math.round(RH + colX[Math.min(C, rect.c2 + 1)] + 24), y: Math.round(CH + rowY[rect.r1]), w: 480, h: 300,
    });
    setChartSel(id);
  };
  const charts = [];
  tab.charts?.forEach((ch, id) => charts.push({ ...ch, id }));

  // ── keyboard ────────────────────────────────────────────────────────
  const onKeyDown = (e) => {
    if (e.target !== scroller.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const id = keyId(e);
    const k = e.key;
    if (chartSel && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); if (canEdit) setExtra(doc, 'charts', tab.id, chartSel, null); setChartSel(''); return; }
    const moveTo = (r, c, extend = e.shiftKey) => {
      r = clamp(r, 0, R - 1); c = clamp(c, 0, C - 1);
      select(extend ? { ...sel, r2: r, c2: c } : { r, c, r2: r, c2: c });
    };
    const from = e.shiftKey ? { r: sel.r2, c: sel.c2 } : { r: sel.r, c: sel.c };
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k] && e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); stepTab(k === 'ArrowUp' ? -1 : 1); return; }
    if (arrows[k] && !e.altKey) {
      e.preventDefault();
      const [dr, dc] = arrows[k];
      if (mod) { const p = edgeFrom(from.r, from.c, dr, dc); moveTo(p.r, p.c); return; }
      const p = step(from.r, from.c, dr, dc);
      moveTo(p.r, p.c);
      return;
    }
    const run = SHORTCUT_RUN[id];
    if (run) { e.preventDefault(); run(); return; }
    if (mod) return;     // Ctrl+C / X / V fall through to the copy, cut and paste events
    const page = Math.max(1, Math.floor((vH - CH - frozenH) / ROW_H) - 1);
    switch (k) {
      case 'Enter': { e.preventDefault(); const p = step(sel.r, sel.c, e.shiftKey ? -1 : 1, 0); select({ r: p.r, c: p.c, r2: p.r, c2: p.c }); return; }
      case 'Tab': { e.preventDefault(); const p = step(sel.r, sel.c, 0, e.shiftKey ? -1 : 1); select({ r: p.r, c: p.c, r2: p.r, c2: p.c }); return; }
      case 'F2': e.preventDefault(); if (e.shiftKey) openNote(); else startEdit(undefined, 'edit'); return;
      case 'Escape': setFind(null); setChartSel(''); return;
      case 'Delete': case 'Backspace': e.preventDefault(); if (canEdit) clearRange(doc, tab.id, b, { skipRows: filtHid }); return;
      case 'PageDown': e.preventDefault(); moveTo(from.r + page, from.c); return;
      case 'PageUp': e.preventDefault(); moveTo(from.r - page, from.c); return;
      case 'Home': e.preventDefault(); moveTo(from.r, 0); return;
      case 'End': e.preventDefault(); moveTo(from.r, Math.max(0, usedExtent().c)); return;
      case ' ':
        if (e.shiftKey) { e.preventDefault(); select({ r: sel.r, c: 0, r2: sel.r2, c2: C - 1 }, false); return; }
        break;
      case 'F11':
        if (e.shiftKey) { e.preventDefault(); if (canEdit) { newTab(); } return; }
        break;
      default:
    }
    if (k.length === 1 && !e.altKey && canEdit && !(e.shiftKey && k === ' ')) { e.preventDefault(); startEdit(k, 'enter'); }
  };
  const stepTab = (d) => {
    const i = ctx.tabs.findIndex((t) => t.id === tab.id);
    const next = ctx.tabs[clamp(i + d, 0, ctx.tabs.length - 1)];
    if (next && next.id !== tab.id) switchTab(next.id);
  };
  const newTab = () => {
    const nid = addTab(doc, null);
    if (nid) switchTab(nid); else toastErr?.(`A sheet holds ${MAX_TABS} tabs at most.`);
  };
  const insertOrDelete = async (del) => {
    if (!guard()) return;
    const rowsWhole = b.c1 === 0 && b.c2 === C - 1, colsWhole = b.r1 === 0 && b.r2 === R - 1;
    const axis = rowsWhole ? 'rows' : colsWhole ? 'cols' : '';
    if (axis) {
      // Ctrl/Cmd+- is also the browser's zoom out: a whole-row delete is asked first.
      if (del) {
        const k = axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
        const what = axis === 'rows' ? (k === 1 ? `row ${b.r1 + 1}` : `${k} rows`) : (k === 1 ? `column ${colName(b.c1)}` : `${k} columns`);
        const ok = await dialog.confirm(`Delete ${what}? Undo brings ${k === 1 ? 'it' : 'them'} back.`, { title: axis === 'rows' ? 'Delete Rows' : 'Delete Columns', confirmText: 'Delete', danger: true });
        if (!ok) return;
      }
      lines(axis, del ? 'delete' : 'before');
      return;
    }
    const at = cellScreen(sel.r, sel.c);
    const n = (axis) => (axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1);
    setMenu({ x: at.x, y: at.y, kind: 'choose', items: del
      ? [{ label: n('rows') === 1 ? 'Delete the Row' : `Delete ${n('rows')} Rows`, onClick: () => lines('rows', 'delete') },
        { label: n('cols') === 1 ? 'Delete the Column' : `Delete ${n('cols')} Columns`, onClick: () => lines('cols', 'delete') }]
      : [{ label: n('rows') === 1 ? 'Insert a Row Above' : `Insert ${n('rows')} Rows Above`, onClick: () => lines('rows', 'before') },
        { label: n('cols') === 1 ? 'Insert a Column Left' : `Insert ${n('cols')} Columns Left`, onClick: () => lines('cols', 'before') }] });
  };
  const today = () => { if (guard()) writeCells(doc, tab.id, [{ r: sel.r, c: sel.c, v: Math.floor(serialFromDate(new Date())), f: null, s: { ...(active?.s || {}), nf: 'date' } }]); };
  const nowTime = () => { if (guard()) { const v = serialFromDate(new Date()); writeCells(doc, tab.id, [{ r: sel.r, c: sel.c, v: v - Math.floor(v), f: null, s: { ...(active?.s || {}), nf: 'time' } }]); } };
  // Every grid shortcut that is not plain movement (see shortcuts.js for the list people read).
  const SHORTCUT_RUN = {
    'Mod+KeyZ': undo, 'Mod+Shift+KeyZ': redo, 'Mod+KeyY': redo,
    'Mod+KeyB': () => toggle('b'), 'Mod+KeyI': () => toggle('i'), 'Mod+KeyU': () => toggle('u'), 'Mod+Digit5': () => toggle('st'),
    'Mod+Digit1': () => setPanel('format'),
    'Mod+KeyA': () => select({ r: 0, c: 0, r2: R - 1, c2: C - 1 }, false),
    'Mod+Space': () => select({ r: 0, c: sel.c, r2: R - 1, c2: sel.c2 }, false),
    'Shift+Space': () => select({ r: sel.r, c: 0, r2: sel.r2, c2: C - 1 }, false),
    'Mod+Home': () => select({ r: 0, c: 0, r2: 0, c2: 0 }),
    'Mod+Shift+Home': () => select({ ...sel, r2: 0, c2: 0 }),
    'Mod+End': () => { const ext = usedExtent(); const r = Math.max(0, ext.r), c = Math.max(0, ext.c); select({ r, c, r2: r, c2: c }); },
    'Mod+PageUp': () => stepTab(-1), 'Mod+PageDown': () => stepTab(1),
    'Mod+KeyF': () => setFind((f) => ({ q: '', rep: '', i: -1, ...(f || {}), replace: false })),
    'Mod+KeyH': () => setFind((f) => ({ q: '', rep: '', i: -1, ...(f || {}), replace: true })),
    'Mod+Shift+KeyH': () => setFind((f) => ({ q: '', rep: '', i: -1, ...(f || {}), replace: true })),
    'Mod+KeyD': () => fillFromEdge('down'), 'Mod+KeyR': () => fillFromEdge('right'),
    'Mod+Semicolon': today, 'Mod+Shift+Semicolon': nowTime,
    'Mod+Shift+Digit4': () => numberFormat('currency', 2), 'Mod+Shift+Digit5': () => numberFormat('percent', 0),
    'Mod+Shift+Digit3': () => numberFormat('date'), 'Mod+Shift+Digit2': () => numberFormat('time'),
    'Mod+Shift+Digit1': () => numberFormat('number', 2), 'Mod+Shift+Backquote': () => numberFormat(''),
    'Mod+Shift+Digit7': () => borders('outer'), 'Mod+Shift+Minus': () => borders('none'),
    'Mod+KeyK': askLink,
    'Mod+Digit9': () => hideLines('rows', true), 'Mod+Shift+Digit9': () => hideLines('rows', false),
    'Mod+Digit0': () => hideLines('cols', true), 'Mod+Shift+Digit0': () => hideLines('cols', false),
    'Mod+Minus': () => insertOrDelete(true), 'Mod+Shift+Equal': () => insertOrDelete(false),
    'Alt+Equal': () => { if (canEdit) startEdit(autoSum(eng, tab, sel.r, sel.c), 'edit'); },
    'Mod+Backquote': () => setShowFormulas((v) => !v),
    'Mod+Shift+KeyL': toggleFilter,
    'Mod+Alt+KeyM': openNote, 'Shift+F2': openNote,
    'Mod+Slash': () => setPanel('shortcuts'),
    'Mod+Shift+KeyV': () => pasteSpecial('values'),
  };

  // ── tabs ────────────────────────────────────────────────────────────
  const switchTab = (id) => { if (edit) commit(); setTabId(id); setSel({ r: 0, c: 0, r2: 0, c2: 0 }); setFind(null); setChartSel(''); scroller.current?.scrollTo?.(0, 0); };
  const renameTab = (id, name) => {
    setRenaming('');
    const n = String(name || '').trim().slice(0, 100);
    const t = ctx.tabById(id);
    if (!n || !t || n === t.name) return;
    if (ctx.tabs.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) { toastErr?.('Another tab already has that name.'); return; }
    setTabMeta(doc, id, { name: n });
  };
  const removeTab = async (id) => {
    const t = ctx.tabById(id);
    if (!t || ctx.tabs.length <= 1) return;
    const ok = await dialog.confirm(`Delete the tab "${t.name}"? Formulas on other tabs that use it will show #REF!. Undo brings it back.`, { title: 'Delete Tab', confirmText: 'Delete', danger: true });
    if (!ok) return;
    const i = ctx.tabs.findIndex((x) => x.id === id);
    deleteTab(doc, id);
    if (id === tab.id) setTabId(ctx.tabs[i === 0 ? 1 : i - 1]?.id || '');
  };

  const importFile = async (file, replace) => {
    if (!file || !guard()) return;
    try {
      const snap = await importSheetFile(file);
      loadSnapshot(doc, snap, { replace });
      setTabId(snap.tabs[0]?.id || '');
      setSel({ r: 0, c: 0, r2: 0, c2: 0 });
    } catch (err) { toastErr?.(err?.message || 'That file could not be read.'); }
  };
  const importMode = useRef(true);
  const askImport = async (replace) => {
    if (replace && !(await dialog.confirm('Replace every tab in this sheet with the file? Undo brings the old tabs back.', { title: 'Import and Replace', confirmText: 'Replace' }))) return;
    importMode.current = replace;
    fileRef.current?.click();
  };
  const download = (kind) => exportSheetFile(doc, title, kind, tab.id, { variables, variableValues }).catch((err) => toastErr?.(err?.message || 'The download did not work.'));

  // ── data tools ──────────────────────────────────────────────────────
  const blockCols = () => Array.from({ length: b.c2 - b.c1 + 1 }, (_, i) => ({ c: b.c1 + i, letter: colName(b.c1 + i), head: shown(b.r1, b.c1 + i) }));
  const dataRect = () => {
    if (b.r1 !== b.r2 || b.c1 !== b.c2) return b;
    const ext = usedExtent();
    return { r1: 0, c1: 0, r2: Math.max(0, ext.r), c2: Math.max(0, ext.c) };
  };
  const removeDuplicates = ({ header, cols }) => {
    if (!guard()) return;
    const rect = dataRect();
    const r0 = header ? rect.r1 + 1 : rect.r1;
    if (tooBig(rect)) return;
    const seen = new Set(), keep = [];
    for (let r = r0; r <= rect.r2; r += 1) {
      const key = JSON.stringify(cols.map((c) => shown(r, c).toLowerCase()));
      if (seen.has(key)) continue;
      seen.add(key);
      keep.push(r);
    }
    const gone = rect.r2 - r0 + 1 - keep.length;
    // The rows that stay move up; their formulas are re-aimed and their notes go with them.
    if (gone) moveRows({ ...rect, r1: r0 }, Array.from({ length: rect.r2 - r0 + 1 }, (_, i) => keep[i] ?? null));
    toastErr?.(gone ? `Removed ${gone} duplicate ${gone === 1 ? 'row' : 'rows'}; ${keep.length} left.` : 'No duplicates found.');
  };
  const splitColumns = async (sep) => {
    if (!guard()) return;
    const list = [];
    let over = 0;
    for (let r = b.r1; r <= b.r2; r += 1) {
      if (filtHid.has(r)) continue;
      const cell = cellAt(r, b.c1);
      if (!cell || cell.f || typeof cell.v !== 'string') continue;
      splitText(cell.v, sep).forEach((part, j) => {
        if (j > 0 && filledCell(cellAt(r, b.c1 + j))) over += 1;
        const p = parseInput(part);
        list.push({ r, c: b.c1 + j, v: p.v ?? null, f: null });
      });
    }
    if (!list.length) return;
    if (over && !(await dialog.confirm(`Splitting replaces what is in ${over} ${over === 1 ? 'cell' : 'cells'} to the right.`, { title: 'Split Text to Columns', confirmText: 'Replace' }))) return;
    write(list);
  };
  const trimWhitespace = () => {
    if (!guard()) return;
    const list = [];
    for (let r = b.r1; r <= b.r2; r += 1) for (let c = b.c1; c <= b.c2; c += 1) {
      const cell = cellAt(r, c);
      if (cell && !cell.f && typeof cell.v === 'string') { const t = cell.v.replace(/[ \t]+/g, ' ').trim(); if (t !== cell.v) list.push({ r, c, v: t, f: null }); }
    }
    if (list.length) write(list);
  };

  // rule lists for the panels
  const cfRules = [];
  tab.cf?.forEach((r, id) => { const rect = ctx.rect(tab, r.range); if (rect) cfRules.push({ ...r, id, a1: a1Of(tab, rect), fText: r.f ? decodeFormula(r.f, ctx, tab.id) : '' }); });
  cfRules.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  const dvRules = [];
  tab.dv?.forEach((r, id) => { const rect = ctx.rect(tab, r.range); if (rect) dvRules.push({ ...r, id, a1: a1Of(tab, rect), srcText: r.src ? decodeFormula(r.src, ctx, tab.id).slice(1) : '' }); });
  const nameList = [];
  ctx.names.forEach((v, key) => { const n = ctx.nameRef(v.name); if (n) nameList.push({ key, name: v.name, a1: a1Of(n.tab, n) }); });
  const encodeRef = (text) => {
    const got = rangeFrom(text);
    if (!got) return null;
    let out = null;
    change(doc, () => {
      const c2 = buildCtx(doc, { grow: true });
      out = encodeFormula('=' + refA1({ sheet: got.tab.id === tab.id ? null : got.tab.name, a: { r: got.rect.r1, c: got.rect.c1 }, b: { r: got.rect.r2, c: got.rect.c2 } }), c2, tab.id);
    });
    return out;
  };
  const saveRule = (kind) => (id, form) => {
    if (!guard()) return false;
    if (!id && extraOf(doc, kind, tab.id).size >= LIMITS[kind]) {
      toastErr?.(`A tab holds ${LIMITS[kind]} ${kind === 'cf' ? 'formatting rules' : 'validation rules'} at most. Delete one first.`);
      return false;
    }
    const got = rangeFrom(form.range);
    if (!got || got.tab.id !== tab.id) { toastErr?.('That range is not on this tab. Use something like A1:C20.'); return false; }
    const rule = { ...form, range: rangeIds(tab, got.rect) };
    for (const k of Object.keys(rule)) if (rule[k] === undefined || rule[k] === '') delete rule[k];
    if (kind === 'cf' && rule.f) {
      try { let enc = null; change(doc, () => { enc = encodeFormula(rule.f, buildCtx(doc, { grow: true }), tab.id); }); rule.f = enc; } catch { toastErr?.('That formula could not be read.'); return false; }
    }
    if (kind === 'dv' && rule.src) { const enc = encodeRef(rule.src); if (!enc) { toastErr?.('Type the choices range like Lists!A1:A20.'); return false; } rule.src = enc; }
    if (kind === 'cf') rule.order = id ? (tab.cf.get(id)?.order ?? Date.now()) : Date.now();
    setExtra(doc, kind, tab.id, id || newId(), rule);
    return true;
  };
  const saveName = (name, range) => {
    if (!guard()) return false;
    if (!okName(name)) { toastErr?.('A name starts with a letter, has no spaces, and is not a cell address like B2.'); return false; }
    if (ctx.names.has(name.toLowerCase())) { toastErr?.('That name is already used.'); return false; }
    if (ctx.names.size >= LIMITS.names) { toastErr?.(`A sheet holds ${LIMITS.names} names at most.`); return false; }
    const got = rangeFrom(range);
    if (!got) { toastErr?.('Type the range like B2:B50 or Sales!A1:A9.'); return false; }
    setName(doc, name.toLowerCase(), { name, tab: got.tab.id, range: rangeIds(got.tab, got.rect) });
    return true;
  };

  // ── drawing ─────────────────────────────────────────────────────────
  const fillBox = fillArea;
  const single = b.r1 === b.r2 && b.c1 === b.c2;
  const renderCell = (r, c, x, y, m = null) => {
    const w = (m ? colX[m.c2 + 1] - colX[m.c1] : colX[c + 1] - colX[c]);
    const h = (m ? rowY[m.r2 + 1] - rowY[m.r1] : rowY[r + 1] - rowY[r]);
    if (w <= 0 || h <= 0) return null;
    const raw = cellAt(r, c);
    const cf = styler ? styler(r, c) : null;
    const s = cf ? { ...(raw?.s || {}), ...cf } : raw?.s || {};
    const isEdit = edit && edit.r === r && edit.c === c;
    const v = eng.cellValue(tab, r, c);
    const rule = tab.dv?.size ? validationAt(ctx, tab, r, c) : null;
    const note = tab.notes?.size ? noteAt(r, c) : null;
    let text = isEdit ? edit.text : showFormulas && raw?.f ? textOf(r, c) : formatValue(v, s);
    const tokens = !isEdit && typeof v === 'string' ? fillTokens(text, variableValues) : null;
    if (tokens) text = tokens.text;
    const shadows = [];
    const inSel = r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;
    const end = m ? { r: m.r2, c: m.c2 } : { r, c };
    if (r === sel.r && c === sel.c) shadows.push('inset 0 0 0 2px var(--nx-primary)');
    else if (inSel) {
      if (r === b.r1) shadows.push('inset 0 1px 0 0 var(--nx-primary)');
      if (end.r === b.r2) shadows.push('inset 0 -1px 0 0 var(--nx-primary)');
      if (c === b.c1) shadows.push('inset 1px 0 0 0 var(--nx-primary)');
      if (end.c === b.c2) shadows.push('inset -1px 0 0 0 var(--nx-primary)');
    }
    let tag = null;
    for (const x of remoteBoxes) {
      if (end.r < x.r1 || r > x.r2 || end.c < x.c1 || c > x.c2) continue;
      if (r <= x.r1) shadows.push(`inset 0 2px 0 0 ${x.color}`);
      if (end.r >= x.r2) shadows.push(`inset 0 -2px 0 0 ${x.color}`);
      if (c <= x.c1) shadows.push(`inset 2px 0 0 0 ${x.color}`);
      if (end.c >= x.c2) shadows.push(`inset -2px 0 0 0 ${x.color}`);
      if (r <= x.r1 && end.c >= x.c2) tag = x;
    }
    const inFill = fillBox && r >= fillBox.r1 && r <= fillBox.r2 && c >= fillBox.c1 && c <= fillBox.c2;
    const align = s.ha || (typeof v === 'number' ? 'right' : typeof v === 'boolean' || isErr(v) ? 'center' : 'left');
    const invalid = rule && rule.kind !== 'checkbox' && !validValue(rule, v, eng, ctx, tab);
    const isCheck = rule?.kind === 'checkbox';
    const isList = rule && (rule.kind === 'list' || rule.kind === 'range');
    const spilled = !raw?.f && !filledCell(raw) && v != null;
    // Long text runs into empty cells to its right, as in Excel.
    let spillW = 0;
    if (!m && !isEdit && text && !s.wrap && align === 'left' && typeof v === 'string' && !isList) {
      for (let cc = c + 1; cc <= Math.min(C - 1, c + 20) && spillW < 2000; cc += 1) {
        if (hidC.has(cc)) continue;
        if (filledCell(cellAt(r, cc)) || eng.cellValue(tab, r, cc) != null || mergeAt(merges, r, cc)) break;
        spillW += colX[cc + 1] - colX[cc];
      }
    }
    const cls = `nxs-cell${inSel && !single ? ' is-in' : ''}${inFill ? ' is-fill' : ''}${tag || spillW ? ' has-tag' : ''}${note ? ' has-note' : ''}${invalid ? ' is-invalid' : ''}${spilled ? ' is-spilled' : ''}${raw?.l ? ' is-link' : ''}${(isList && !isEdit && canEdit) || (filt && r === filt.r && c >= filt.c1 && c <= filt.c2) ? ' has-btn' : ''}`;
    const titleText = [isErr(v) && v.note ? v.note : '', note ? `${note.by ? note.by + ': ' : ''}${note.text}` : '', invalid ? `Not valid: this cell takes ${ruleWords(rule)}` : '', raw?.l ? `${raw.l} (${MOD}+click to open)` : ''].filter(Boolean).join('\n');
    return (
      <div key={`${r}:${c}`} className={cls} data-r={r} data-c={c}
        aria-label={r === sel.r && c === sel.c ? `${a1(r, c)}, ${text || 'blank'}` : undefined}
        title={titleText || undefined}
        style={{
          left: x, top: y, width: w, height: h, boxShadow: shadows.join(', ') || undefined,
          background: s.bg || undefined, color: s.fc || (isErr(v) ? 'hsl(var(--color-red, 4 74% 49%))' : undefined),
          fontWeight: s.b ? 700 : undefined, fontStyle: s.i ? 'italic' : undefined,
          fontFamily: s.ff ? `"${s.ff}", Inter, sans-serif` : undefined, fontSize: s.fs ? s.fs : undefined,
          textDecoration: [s.u && 'underline', s.st && 'line-through'].filter(Boolean).join(' ') || undefined,
          justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
          whiteSpace: s.wrap ? 'pre-wrap' : 'pre', alignItems: s.va === 'top' ? 'flex-start' : s.va === 'middle' ? 'center' : (s.wrap ? 'flex-start' : 'flex-end'),
          borderTop: borderCss(s.bt), borderBottom: borderCss(s.bb) ?? undefined, borderLeft: borderCss(s.bl), borderRight: borderCss(s.br) ?? undefined,
        }}>
        {isEdit && edit.from === 'cell' ? (
          <textarea className="nxs-cell-input" autoFocus value={edit.text} spellCheck={false} aria-label={`Edit ${a1(r, c)}`} rows={1}
            ref={(el) => { if (el) editEl.current = el; }}
            style={{ textAlign: edit.text.startsWith('=') ? 'left' : align, minWidth: w, minHeight: h }}
            // A textarea opens with the caret at 0: put it after the typed first key / the text (Excel's F2).
            onFocus={(e) => { const el = e.currentTarget; editEl.current = el; el.setSelectionRange(el.value.length, el.value.length); }}
            onChange={(e) => { setEdit({ ...edit, text: e.target.value }); setPick(0); }} onKeyDown={editKey} />
        ) : isCheck ? (
          <span className="nxs-checkbox" data-check={`${r}:${c}`} role="checkbox" aria-checked={v === true} aria-label={`${a1(r, c)} checkbox`}>
            {v === true ? <CheckSquare size={15} /> : <Square size={15} />}
          </span>
        ) : (
          <span className="nxs-text" style={spillW ? { width: w + spillW - 10, maxWidth: 'none', background: s.bg || 'var(--card)' } : undefined}>
            {tokens ? tokens.parts.map((p, i) => (p.token ? <span key={i} className={`nxs-var${p.missing ? ' is-missing' : ''}`} title={p.missing ? 'Pick a person or company for this sheet' : `{{${p.token}}}`}>{p.text}</span> : p.text)) : text}
          </span>
        )}
        {isList && !isEdit && canEdit && <button type="button" tabIndex={-1} className="nxs-dv-arrow" data-dv-arrow={`${r}:${c}`} aria-label="Choose a Value"><Caret size={12} /></button>}
        {filt && r === filt.r && c >= filt.c1 && c <= filt.c2 && (
          <button type="button" tabIndex={-1} className={`nxs-filter-btn${filt.crit[tab.cols[c]] ? ' is-on' : ''}`} data-filter-col={c} aria-label={`Filter ${colName(c)}`}><Filter size={11} /></button>
        )}
        {tag && <span className="nxs-tag" style={{ background: tag.color }}>{tag.name}</span>}
        {canEdit && !edit && end.r === b.r2 && end.c === b.c2 && <span className="nxs-fill" data-fill="1" aria-hidden="true" />}
      </div>
    );
  };
  /** Cells of rows x cols at the offsets given; a merge is drawn once, from its corner, even if the corner is off screen. */
  const region = (rows, cols, xOf, yOf) => {
    const out = [], seen = new Set();
    for (const r of rows) {
      if (hidR.has(r)) continue;
      for (const c of cols) {
        if (hidC.has(c)) continue;
        const m = merges.length ? mergeAt(merges, r, c) : null;
        if (m) {
          const k = `${m.r1}|${m.c1}`;
          if (!seen.has(k)) { seen.add(k); out.push(renderCell(m.r1, m.c1, xOf(m.c1), yOf(m.r1), m)); }
          continue;
        }
        out.push(renderCell(r, c, xOf(c), yOf(r)));
      }
    }
    return out;
  };
  const colHead = (c, x) => (hidC.has(c) ? null : (
    <div key={`h${c}`} className={`nxs-head nxs-colhead${c >= b.c1 && c <= b.c2 ? ' is-on' : ''}${hidC.has(c + 1) || hidC.has(c - 1) ? ' has-hidden' : ''}`} data-col={c}
      style={{ left: x, top: 0, width: colX[c + 1] - colX[c], height: CH }}>
      {colName(c)}
      {canEdit && <span className="nxs-rz nxs-rz-col" data-resize={`col:${c}`} aria-hidden="true" />}
    </div>
  ));
  const rowHead = (r, y) => (hidR.has(r) ? null : (
    <div key={`r${r}`} className={`nxs-head nxs-rowhead${r >= b.r1 && r <= b.r2 ? ' is-on' : ''}${hidR.has(r + 1) || hidR.has(r - 1) ? ' has-hidden' : ''}`} data-row={r}
      style={{ left: 0, top: y, width: RH, height: rowY[r + 1] - rowY[r] }}>
      {r + 1}
      {canEdit && <span className="nxs-rz nxs-rz-row" data-resize={`row:${r}`} aria-hidden="true" />}
    </div>
  ));

  const bodyRows = [], bodyCols = [];
  for (let r = rA; r <= rB; r += 1) bodyRows.push(r);
  for (let c = cA; c <= cB; c += 1) bodyCols.push(c);
  const frozenRowList = Array.from({ length: fr }, (_, i) => i);
  const frozenColList = Array.from({ length: fc }, (_, i) => i);

  const s0 = active?.s || {};
  const barText = edit ? edit.text : textOf(sel.r, sel.c);
  const [nameText, setNameText] = useState(null);
  const nameBox = nameText ?? (single ? a1(sel.r, sel.c) : `${a1(b.r1, b.c1)}:${a1(b.r2, b.c2)}`);
  const n = (axis) => (axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1);
  const many = (k, word1) => (k === 1 ? `1 ${word1}` : `${k} ${word1}s`);
  const hasHiddenRows = Array.from({ length: n('rows') + 2 }, (_, i) => b.r1 - 1 + i).some((r) => hidR.has(r) && tab.hidden?.has(tab.rows[r]));
  const hasHiddenCols = Array.from({ length: n('cols') + 2 }, (_, i) => b.c1 - 1 + i).some((c) => hidC.has(c));

  const cellMenu = [
    { label: 'Cut', onClick: () => { focusGrid(); document.execCommand?.('cut'); }, disabled: !canEdit },
    { label: 'Copy', onClick: () => { focusGrid(); document.execCommand?.('copy'); } },
    { label: 'Paste', onClick: () => pasteSpecial(''), disabled: !canEdit },
    { label: 'Paste Values Only', onClick: () => pasteSpecial('values'), disabled: !canEdit },
    '-',
    { label: `Insert ${many(n('rows'), 'Row')} Above`, onClick: () => lines('rows', 'before'), disabled: !canEdit },
    { label: `Insert ${many(n('rows'), 'Row')} Below`, onClick: () => lines('rows', 'after'), disabled: !canEdit },
    { label: `Insert ${many(n('cols'), 'Column')} Left`, onClick: () => lines('cols', 'before'), disabled: !canEdit },
    { label: `Insert ${many(n('cols'), 'Column')} Right`, onClick: () => lines('cols', 'after'), disabled: !canEdit },
    '-',
    { label: n('rows') === 1 ? 'Delete Row' : `Delete ${n('rows')} Rows`, onClick: () => lines('rows', 'delete'), disabled: !canEdit || n('rows') >= R },
    { label: n('cols') === 1 ? 'Delete Column' : `Delete ${n('cols')} Columns`, onClick: () => lines('cols', 'delete'), disabled: !canEdit || n('cols') >= C },
    { label: n('rows') === 1 ? 'Hide Row' : `Hide ${n('rows')} Rows`, onClick: () => hideLines('rows', true), disabled: !canEdit },
    { label: n('cols') === 1 ? 'Hide Column' : `Hide ${n('cols')} Columns`, onClick: () => hideLines('cols', true), disabled: !canEdit },
    ...(hasHiddenRows ? [{ label: 'Unhide Rows', onClick: () => hideLines('rows', false), disabled: !canEdit }] : []),
    ...(hasHiddenCols ? [{ label: 'Unhide Columns', onClick: () => hideLines('cols', false), disabled: !canEdit }] : []),
    '-',
    { label: 'Clear Contents', onClick: () => clearRange(doc, tab.id, b, { skipRows: filtHid }), disabled: !canEdit },
    { label: 'Clear Formatting', onClick: () => applyStyle({ b: null, i: null, u: null, st: null, fc: null, bg: null, ha: null, va: null, wrap: null, nf: null, d: null, ff: null, fs: null, bt: null, bb: null, bl: null, br: null }), disabled: !canEdit },
    { label: noteAt(sel.r, sel.c) ? 'Edit Note' : 'Insert Note', icon: StickyNote, onClick: openNote, disabled: !canEdit },
    { label: active?.l ? 'Edit Link' : 'Insert Link', icon: Link2, onClick: askLink, disabled: !canEdit },
    '-',
    { label: 'Sort A to Z', icon: ArrowDownAZ, onClick: () => sortBy(false), disabled: !canEdit },
    { label: 'Sort Z to A', icon: ArrowUpZA, onClick: () => sortBy(true), disabled: !canEdit },
  ];
  const menuItems = menu?.kind === 'choose' ? menu.items
    : menu?.kind === 'col' ? cellMenu.filter((it) => it === '-' || !/Row/.test(it.label))
      : menu?.kind === 'row' ? cellMenu.filter((it) => it === '-' || !/Column|Sort/.test(it.label)) : cellMenu;

  const freezeItems = (axis) => {
    const cur = axis === 'rows' ? fr : fc, at = axis === 'rows' ? sel.r + 1 : sel.c + 1;
    const key = axis === 'rows' ? 'frozenRows' : 'frozenCols';
    const word1 = axis === 'rows' ? 'Row' : 'Column';
    const opts = [[0, `No ${word1}s`], [1, `1 ${word1}`], [2, `2 ${word1}s`]];
    if (at > 2) opts.push([at, `Up to ${axis === 'rows' ? `Row ${at}` : `Column ${colName(at - 1)}`}`]);
    return opts.map(([k, label]) => ({ label: `Freeze ${label}`, active: cur === k, onClick: () => canEdit && setTabMeta(doc, tab.id, { [key]: k }), disabled: !canEdit }));
  };
  const openVars = (e) => { const r = e.currentTarget.getBoundingClientRect(); setPop({ kind: 'vars', at: { x: r.left, y: r.bottom + 4 } }); };

  // What the active cell carries that the grid only hints at: a note, a link, a rule, a spill, a variable.
  const activeV = eng.cellValue(tab, sel.r, sel.c);
  const activeRule = validationAt(ctx, tab, sel.r, sel.c);
  const activeNote = noteAt(sel.r, sel.c);
  const info = [];
  if (activeNote) info.push({ k: 'note', text: `${activeNote.by ? activeNote.by + ': ' : ''}${activeNote.text}` });
  if (active?.l) info.push({ k: 'link', text: active.l });
  if (isErr(activeV) && activeV.note) info.push({ k: 'err', text: `${activeV.code} ${activeV.note}` });
  if (activeRule && activeRule.kind !== 'checkbox' && !validValue(activeRule, activeV, eng, ctx, tab)) info.push({ k: 'err', text: `Not valid: this cell takes ${ruleWords(activeRule)}.` });

  return (
    <div className="nx-sheet">
      <div className="doc-toolbar doc-ribbon nxs-toolbar" role="toolbar" aria-label="Sheet tools">
        <SmallBtn icon={Undo2} title={`Undo (${MOD}+Z)`} onClick={undo} disabled={!canEdit || !stacks.undo} />
        <SmallBtn icon={Redo2} title={`Redo (${MOD}+Y)`} onClick={redo} disabled={!canEdit || !stacks.redo} />
        <span className="doc-toolbar-sep" />
        <Menu label="File" title="File" items={[
          { label: 'Import and Replace', icon: FileUp, onClick: () => askImport(true), disabled: !canEdit },
          { label: 'Import as New Tabs', icon: FileUp, onClick: () => askImport(false), disabled: !canEdit },
          '-',
          { label: 'Download as .xlsx', icon: FileDown, onClick: () => download('xlsx') },
          { label: 'Download This Tab as .csv', icon: FileDown, onClick: () => download('csv') },
        ]} />
        <Menu label="Edit" title="Edit" items={[
          { label: `Undo (${MOD}+Z)`, onClick: undo, disabled: !canEdit || !stacks.undo },
          { label: `Redo (${MOD}+Y)`, onClick: redo, disabled: !canEdit || !stacks.redo },
          '-',
          { label: 'Paste Values Only', onClick: () => pasteSpecial('values'), disabled: !canEdit },
          { label: 'Paste Formatting Only', onClick: () => pasteSpecial('formats'), disabled: !canEdit },
          { label: 'Paste Formulas Only', onClick: () => pasteSpecial('formulas'), disabled: !canEdit },
          { label: 'Paste Transposed', onClick: () => pasteSpecial('transpose'), disabled: !canEdit },
          '-',
          { label: `Fill Down (${MOD}+D)`, onClick: () => fillFromEdge('down'), disabled: !canEdit },
          { label: `Fill Right (${MOD}+R)`, onClick: () => fillFromEdge('right'), disabled: !canEdit },
          { label: `Find and Replace (${MOD}+H)`, onClick: () => setFind((f) => ({ q: '', rep: '', i: -1, ...(f || {}), replace: true })) },
        ]} />
        <Menu label="Insert" title="Insert" items={[
          { label: 'Chart', icon: BarChart3, onClick: insertChart, disabled: !canEdit },
          { label: 'Note', icon: StickyNote, onClick: openNote, disabled: !canEdit },
          { label: 'Link', icon: Link2, onClick: askLink, disabled: !canEdit },
          { label: 'Checkbox', icon: CheckSquare, onClick: () => saveRule('dv')(null, { range: selA1, kind: 'checkbox' }), disabled: !canEdit },
          { label: 'Dropdown', onClick: () => setPanel('dv'), disabled: !canEdit },
          '-',
          { label: `${many(n('rows'), 'Row')} Above`, onClick: () => lines('rows', 'before'), disabled: !canEdit },
          { label: `${many(n('rows'), 'Row')} Below`, onClick: () => lines('rows', 'after'), disabled: !canEdit },
          { label: `${many(n('cols'), 'Column')} Left`, onClick: () => lines('cols', 'before'), disabled: !canEdit },
          { label: `${many(n('cols'), 'Column')} Right`, onClick: () => lines('cols', 'after'), disabled: !canEdit },
          { label: 'Tab', onClick: () => { newTab(); }, disabled: !canEdit },
        ]} />
        <Menu label="Format" title="Format" items={[
          { label: `Format Cells (${MOD}+1)`, onClick: () => setPanel('format'), disabled: !canEdit },
          { label: 'Conditional Formatting', onClick: () => setPanel('cf'), disabled: !canEdit },
          '-',
          { label: 'Merge All', onClick: () => mergeCells('all'), disabled: !canEdit },
          { label: 'Merge Horizontally', onClick: () => mergeCells('rows'), disabled: !canEdit },
          { label: 'Unmerge', onClick: () => mergeCells('unmerge'), disabled: !canEdit },
          '-',
          { label: 'Clear Formatting', onClick: () => applyStyle({ b: null, i: null, u: null, st: null, fc: null, bg: null, ha: null, va: null, wrap: null, nf: null, d: null, ff: null, fs: null, bt: null, bb: null, bl: null, br: null }), disabled: !canEdit },
        ]} />
        <Menu label="Data" title="Data" items={[
          { label: 'Sort Range', onClick: () => setPanel('sort'), disabled: !canEdit },
          { label: filt ? 'Remove Filter' : 'Create a Filter', icon: Filter, onClick: toggleFilter, disabled: !canEdit },
          { label: 'Data Validation', onClick: () => setPanel('dv'), disabled: !canEdit },
          { label: 'Named Ranges', onClick: () => setPanel('names') },
          '-',
          { label: 'Remove Duplicates', onClick: () => setPanel('dedupe'), disabled: !canEdit },
          { label: 'Split Text to Columns', onClick: () => setPanel('split'), disabled: !canEdit },
          { label: 'Trim Whitespace', onClick: trimWhitespace, disabled: !canEdit },
        ]} />
        <Menu label="View" title="View" items={[
          ...freezeItems('rows'), '-', ...freezeItems('cols'), '-',
          { label: tab.grid ? 'Hide Gridlines' : 'Show Gridlines', onClick: () => canEdit && setTabMeta(doc, tab.id, { grid: !tab.grid }), disabled: !canEdit },
          { label: showFormulas ? `Hide Formulas (${MOD}+\`)` : `Show Formulas (${MOD}+\`)`, onClick: () => setShowFormulas((v) => !v) },
          '-',
          ...ZOOMS.map((zz) => ({ label: `Zoom ${zz}%`, active: zoom === zz, onClick: () => setZoom(zz) })),
        ]} />
        <Menu label="Help" title="Help" items={[{ label: `Keyboard Shortcuts (${MOD}+/)`, icon: Keyboard, onClick: () => setPanel('shortcuts') }]} />
        <span className="doc-toolbar-sep" />
        <select className="nxs-select" aria-label="Number Format" value={s0.nf || ''} disabled={!canEdit}
          onChange={(e) => numberFormat(e.target.value)}>
          {NUMBER_FORMATS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <SmallBtn title="Fewer Decimal Places" onClick={() => decimals(-1)} disabled={!canEdit}><span className="nxs-dec">.0</span></SmallBtn>
        <SmallBtn title="More Decimal Places" onClick={() => decimals(1)} disabled={!canEdit}><span className="nxs-dec">.00</span></SmallBtn>
        <span className="doc-toolbar-sep" />
        <select className="nxs-select" aria-label="Font" value={s0.ff || 'Inter'} disabled={!canEdit} onChange={(e) => applyStyle({ ff: e.target.value === 'Inter' ? null : e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select className="nxs-select nxs-size" aria-label="Font Size" value={s0.fs || 13} disabled={!canEdit} onChange={(e) => applyStyle({ fs: +e.target.value === 13 ? null : +e.target.value })}>
          {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <SmallBtn icon={Bold} title={`Bold (${MOD}+B)`} active={!!s0.b} onClick={() => toggle('b')} disabled={!canEdit} />
        <SmallBtn icon={Italic} title={`Italic (${MOD}+I)`} active={!!s0.i} onClick={() => toggle('i')} disabled={!canEdit} />
        <SmallBtn icon={Underline} title={`Underline (${MOD}+U)`} active={!!s0.u} onClick={() => toggle('u')} disabled={!canEdit} />
        <SmallBtn icon={Strikethrough} title={`Strikethrough (${MOD}+5)`} active={!!s0.st} onClick={() => toggle('st')} disabled={!canEdit} />
        <Menu icon={Baseline} title="Text Color" disabled={!canEdit}>
          {(close) => <ColorGrid rows={COLOR_ROWS} current={s0.fc} onPick={(hex) => { applyStyle({ fc: hex.toLowerCase() }); close(); }} onNone={() => { applyStyle({ fc: null }); close(); }} noneLabel="Automatic" />}
        </Menu>
        <Menu icon={PaintBucket} title="Fill Color" disabled={!canEdit}>
          {(close) => <ColorGrid rows={COLOR_ROWS} current={s0.bg} onPick={(hex) => { applyStyle({ bg: hex.toLowerCase() }); close(); }} onNone={() => { applyStyle({ bg: null }); close(); }} />}
        </Menu>
        <Menu icon={Grid3x3} title="Borders" disabled={!canEdit} items={[
          { label: 'All Borders', onClick: () => borders('all') }, { label: 'Outer Borders', onClick: () => borders('outer') },
          { label: 'Inner Borders', onClick: () => borders('inner') }, '-',
          { label: 'Top Border', onClick: () => borders('top') }, { label: 'Bottom Border', onClick: () => borders('bottom') },
          { label: 'Left Border', onClick: () => borders('left') }, { label: 'Right Border', onClick: () => borders('right') }, '-',
          { label: 'Thick Outer Border', onClick: () => borders('outer', 'thick') }, { label: 'Dashed Outer Border', onClick: () => borders('outer', 'dashed') },
          { label: 'No Borders', onClick: () => borders('none') }, { label: 'More Border Styles', onClick: () => setPanel('format') },
        ]} />
        <SmallBtn icon={Combine} title="Merge Cells" active={!!mergeAt(merges, sel.r, sel.c)} onClick={() => mergeCells(mergeAt(merges, sel.r, sel.c) ? 'unmerge' : 'all')} disabled={!canEdit} />
        <span className="doc-toolbar-sep" />
        <SmallBtn icon={AlignLeft} title="Align Left" active={s0.ha === 'left'} onClick={() => applyStyle({ ha: s0.ha === 'left' ? null : 'left' })} disabled={!canEdit} />
        <SmallBtn icon={AlignCenter} title="Align Center" active={s0.ha === 'center'} onClick={() => applyStyle({ ha: s0.ha === 'center' ? null : 'center' })} disabled={!canEdit} />
        <SmallBtn icon={AlignRight} title="Align Right" active={s0.ha === 'right'} onClick={() => applyStyle({ ha: s0.ha === 'right' ? null : 'right' })} disabled={!canEdit} />
        <Menu icon={AlignVerticalJustifyEnd} title="Vertical Align" disabled={!canEdit} items={[
          { label: 'Top', icon: AlignVerticalJustifyStart, active: s0.va === 'top', onClick: () => applyStyle({ va: 'top' }) },
          { label: 'Middle', icon: AlignVerticalJustifyCenter, active: s0.va === 'middle', onClick: () => applyStyle({ va: 'middle' }) },
          { label: 'Bottom', icon: AlignVerticalJustifyEnd, active: !s0.va, onClick: () => applyStyle({ va: null }) },
        ]} />
        <SmallBtn icon={WrapText} title="Wrap Text" active={!!s0.wrap} onClick={() => toggle('wrap')} disabled={!canEdit} />
        <span className="doc-toolbar-sep" />
        <SmallBtn icon={Link2} title={`Insert Link (${MOD}+K)`} active={!!active?.l} onClick={askLink} disabled={!canEdit} />
        <SmallBtn icon={BarChart3} title="Insert Chart" onClick={insertChart} disabled={!canEdit} />
        <SmallBtn icon={Filter} title={`Filter (${MOD}+Shift+L)`} active={!!filt} onClick={toggleFilter} disabled={!canEdit} />
        <SmallBtn icon={ArrowDownAZ} title="Sort A to Z" onClick={() => sortBy(false)} disabled={!canEdit} />
        <SmallBtn icon={ArrowUpZA} title="Sort Z to A" onClick={() => sortBy(true)} disabled={!canEdit} />
        <SmallBtn icon={Search} title={`Find (${MOD}+F)`} active={!!find} onClick={() => setFind((f) => (f ? null : { q: '', rep: '', i: -1, replace: false }))} />
        <button type="button" className="doc-ribbon-small nxs-var-btn" title="Insert a Variable" aria-label="Insert a Variable" onClick={openVars} disabled={!canEdit}>
          <Variable size={15} /><span>Variable</span>
        </button>
        <select className="nxs-select nxs-size" aria-label="Zoom" value={zoom} onChange={(e) => setZoom(+e.target.value)}>
          {ZOOMS.map((zz) => <option key={zz} value={zz}>{zz}%</option>)}
        </select>
        {(fr > 0 || fc > 0) && <span className="nxs-frozen" title="Rows or columns are frozen (View menu)"><Snowflake size={13} /></span>}
        {!canEdit && <span className="nxs-readonly">View Only</span>}
      </div>

      <div className="nxs-bar">
        <input className="nxs-namebox" aria-label="Name Box" value={nameBox} spellCheck={false}
          onFocus={(e) => { setNameText(nameBox); e.target.select(); }}
          onChange={(e) => setNameText(e.target.value)}
          onBlur={() => setNameText(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setNameText(null); focusGrid(); }
            if (e.key !== 'Enter') return;
            const text = nameText ?? '';
            const p = parseA1(text) || (() => { const n2 = ctx.nameRef(text.trim()); if (!n2) return null; if (n2.tab.id !== tab.id) switchTab(n2.tab.id); return { r: n2.r1, c: n2.c1, r2: n2.r2, c2: n2.c2 }; })();
            setNameText(null);
            if (p) select({ r: clamp(p.r, 0, R - 1), c: clamp(p.c, 0, C - 1), r2: clamp(p.r2, 0, R - 1), c2: clamp(p.c2, 0, C - 1) });
            focusGrid();
          }} />
        <span className="nxs-fx" aria-hidden="true">fx</span>
        <div className="nxs-formula-wrap">
          <textarea className="nxs-formula" aria-label="Formula Bar" value={barText} readOnly={!canEdit} spellCheck={false} rows={1}
            onFocus={(e) => { editEl.current = e.currentTarget; if (canEdit && !edit) startEdit(undefined, 'edit', 'bar'); else if (edit) setEdit((ed) => ({ ...ed, from: 'bar' })); }}
            onChange={(e) => { setEdit((ed) => ({ ...(ed || { r: sel.r, c: sel.c, mode: 'edit' }), from: 'bar', text: e.target.value })); setPick(0); }}
            onKeyDown={editKey} />
          {(suggestions.length > 0 || hint) && (
            <div className="nxs-suggest" role="listbox" aria-label="Functions">
              {suggestions.map((name, i) => (
                <button key={name} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'is-on' : ''}
                  onMouseDown={(e) => { e.preventDefault(); accept(name); }}>
                  <b>{name}</b><span>{SIGS[name]}</span>
                </button>
              ))}
              {!suggestions.length && hint && <div className="nxs-hint">{hint}</div>}
            </div>
          )}
        </div>
      </div>

      {info.length > 0 && (
        <div className="nxs-info" role="status">
          {info.map((x, i) => (
            <span key={i} className={`nxs-info-${x.k}`}>
              {x.k === 'note' && <StickyNote size={12} />}
              {x.k === 'link' ? <><Link2 size={12} /><a href={safeLink(x.text)} target="_blank" rel="noopener noreferrer">{x.text}</a></> : x.text}
            </span>
          ))}
        </div>
      )}

      {find && (
        <div className="nxs-find">
          <Search size={14} />
          <input autoFocus placeholder="Find in this tab" aria-label="Find in this tab" value={find.q}
            onChange={(e) => setFind({ ...find, q: e.target.value, i: -1 })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { setFind(null); focusGrid(); } }} />
          {find.replace && (
            <>
              <input placeholder="Replace with" aria-label="Replace with" value={find.rep || ''} onChange={(e) => setFind({ ...find, rep: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') { setFind(null); focusGrid(); } }} />
              <button type="button" className="nxs-text-btn" onClick={() => replaceMatches(false)} disabled={!canEdit || !matches.length}>Replace</button>
              <button type="button" className="nxs-text-btn" onClick={() => replaceMatches(true)} disabled={!canEdit || !matches.length}>Replace All</button>
            </>
          )}
          <label className="nxs-check nxs-inline"><input type="checkbox" checked={!!find.mc} onChange={(e) => setFind({ ...find, mc: e.target.checked, i: -1 })} /> Match Case</label>
          <label className="nxs-check nxs-inline"><input type="checkbox" checked={!!find.whole} onChange={(e) => setFind({ ...find, whole: e.target.checked, i: -1 })} /> Whole Cell</label>
          <span className="nxs-find-count">{find.q ? `${matches.length ? (find.i >= 0 ? find.i + 1 : 0) : 0} of ${matches.length}` : ''}</span>
          <button type="button" aria-label="Previous Match" title="Previous Match" onClick={() => findStep(-1)}><ChevronUp size={15} /></button>
          <button type="button" aria-label="Next Match" title="Next Match" onClick={() => findStep(1)}><ChevronDown size={15} /></button>
          {!find.replace && <button type="button" className="nxs-text-btn" onClick={() => setFind({ ...find, replace: true })}>Replace</button>}
          <button type="button" aria-label="Close Find" title="Close Find" onClick={() => { setFind(null); focusGrid(); }}><X size={15} /></button>
        </div>
      )}

      <div ref={scroller} className={`nxs-scroll${tab.grid ? '' : ' nxs-nogrid'}`} tabIndex={0} role="grid" aria-rowcount={R} aria-colcount={C}
        aria-label={`${tab.name}, ${a1(sel.r, sel.c)}, ${shown(sel.r, sel.c) || 'blank'}`}
        onScroll={onScroll} onKeyDown={onKeyDown} onMouseDown={onMouseDown} onMouseOver={onMouseOver}
        onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
        onCopy={(e) => copyBlock(e, false)} onCut={(e) => copyBlock(e, true)} onPaste={onPaste}>
        <div className="nxs-canvas" style={{ width: totalW, height: totalH, zoom: z === 1 ? undefined : z }}>
          <div className="nxs-band-top" style={{ height: CH + frozenH }}>
            <div className="nxs-corner" style={{ width: RH + frozenW, height: CH + frozenH }}>
              <div className="nxs-head nxs-all" data-all="1" title="Select All" style={{ left: 0, top: 0, width: RH, height: CH }} />
              {frozenColList.map((c) => colHead(c, RH + colX[c]))}
              {frozenRowList.map((r) => rowHead(r, CH + rowY[r]))}
              {region(frozenRowList, frozenColList, (c) => RH + colX[c], (r) => CH + rowY[r])}
            </div>
            {bodyCols.map((c) => colHead(c, RH + colX[c]))}
            {region(frozenRowList, bodyCols, (c) => RH + colX[c], (r) => CH + rowY[r])}
          </div>
          <div className="nxs-band-left" style={{ width: RH + frozenW }}>
            {bodyRows.map((r) => rowHead(r, rowY[r] - frozenH))}
            {region(bodyRows, frozenColList, (c) => RH + colX[c], (r) => rowY[r] - frozenH)}
          </div>
          {region(bodyRows, bodyCols, (c) => RH + colX[c], (r) => CH + rowY[r])}
          {charts.map((ch) => {
            const rect = ctx.rect(tab, ch.range);
            const data = rect ? chartData(eng, ctx, tab, rect, ch.header ?? null) : { categories: [], series: [] };
            return (
              <ChartBox key={ch.id} chart={ch} data={data} selected={chartSel === ch.id} canEdit={canEdit} zoom={z}
                onSelect={() => { setChartSel(ch.id); focusGrid(); }}
                onChange={(patch) => { const cur = tab.charts.get(ch.id); if (cur && canEdit) setExtra(doc, 'charts', tab.id, ch.id, { ...cur, ...patch }); }}
                onDelete={() => { if (canEdit) setExtra(doc, 'charts', tab.id, ch.id, null); setChartSel(''); }} />
            );
          })}
          {canEdit && (
            <div className="nxs-more" data-add-rows="1" style={{ top: CH + rowY[R] + 10, left: RH + 10 }}>
              <button type="button" onClick={() => insertLines(doc, tab.id, 'rows', R, 1000)}>Add 1,000 More Rows</button>
            </div>
          )}
        </div>
      </div>

      <div className="nxs-tabs" role="tablist" aria-label="Tabs">
        {canEdit && (
          <button type="button" className="nxs-tab-add" title="Add Tab (Shift+F11)" aria-label="Add Tab"
            onClick={() => { newTab(); }}><Plus size={15} /></button>
        )}
        {ctx.tabs.map((t) => {
          const on = t.id === tab.id;
          return (
            <div key={t.id} className={`nxs-tab${on ? ' is-on' : ''}`} style={{ borderBottomColor: t.color || undefined }}>
              {renaming === t.id ? (
                <input autoFocus defaultValue={t.name} aria-label="Tab Name" maxLength={100}
                  onBlur={(e) => renameTab(t.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(''); }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} onClick={() => switchTab(t.id)}
                  onDoubleClick={() => canEdit && setRenaming(t.id)}>{t.name}</button>
              )}
              {on && canEdit && renaming !== t.id && (
                <button type="button" className="nxs-tab-menu" aria-label={`${t.name} Options`} title="Tab Options"
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top - 4, kind: 'tab', up: true }); }}>
                  <MoreVertical size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f, importMode.current); }} />

      {menu && menu.kind !== 'tab' && <PopMenu at={menu} items={menuItems} onClose={() => setMenu(null)} />}
      {menu?.kind === 'tab' && (
        <PopMenu at={menu} onClose={() => setMenu(null)} items={[
          { label: 'Rename', onClick: () => setRenaming(tab.id) },
          { label: 'Duplicate', onClick: () => { const nid = duplicateTab(doc, tab.id); if (nid) switchTab(nid); } },
          { label: 'Move Left', onClick: () => moveTab(doc, tab.id, -1), disabled: ctx.tabs[0]?.id === tab.id },
          { label: 'Move Right', onClick: () => moveTab(doc, tab.id, 1), disabled: ctx.tabs[ctx.tabs.length - 1]?.id === tab.id },
          '-',
          { label: 'Delete', onClick: () => removeTab(tab.id), disabled: ctx.tabs.length <= 1 },
        ]}>
          <div className="doc-ribbon-sep" />
          <div className="nxs-pop-label">Tab Color</div>
          <ColorGrid rows={[STANDARD_COLORS.map((h) => [h])]} more={false} current={tab.color}
            onPick={(hex) => { setTabMeta(doc, tab.id, { color: hex.toLowerCase() }); setMenu(null); }}
            onNone={() => { setTabMeta(doc, tab.id, { color: '' }); setMenu(null); }} />
        </PopMenu>
      )}

      {pop?.kind === 'filter' && (
        <FilterPop at={pop.at} title={pop.title} values={pop.values} crit={pop.crit} onClose={() => setPop(null)}
          onApply={(crit) => setFilterCrit(pop.c, crit)}
          onSort={(desc) => filt && sortRows({ r1: filt.r + 1, r2: filt.last, c1: filt.c1, c2: filt.c2 }, [{ c: pop.c, desc }])} />
      )}
      {pop?.kind === 'list' && <ListPick at={pop.at} items={pop.items} current={pop.current} onClose={() => setPop(null)} onPick={(v) => pickFromList(pop.r, pop.c, v)} />}
      {pop?.kind === 'note' && (() => {
        const nt = noteAt(pop.r, pop.c);
        return <NoteEditor at={pop.at} note={nt ? { ...nt, atText: nt.at ? `${usDate(serialFromDate(new Date(nt.at)))}` : '' } : null}
          onClose={() => { setPop(null); focusGrid(); }} onSave={(t) => saveNote(pop.r, pop.c, t)} onDelete={() => saveNote(pop.r, pop.c, '')} />;
      })()}
      {pop?.kind === 'vars' && <VariablePicker at={pop.at} variables={variables} values={variableValues} onClose={() => setPop(null)} onPick={pickVariable} />}

      {panel === 'shortcuts' && <ShortcutsPanel onClose={() => { setPanel(null); focusGrid(); }} />}
      {panel === 'format' && <FormatPanel s={s0} onStyle={applyStyle} onBorder={borders} onClose={() => { setPanel(null); focusGrid(); }} />}
      {panel === 'cf' && <ConditionalPanel rules={cfRules} selA1={selA1} toastErr={toastErr} onSave={saveRule('cf')} onDelete={(id) => setExtra(doc, 'cf', tab.id, id, null)} onClose={() => setPanel(null)} />}
      {panel === 'dv' && <ValidationPanel rules={dvRules} selA1={selA1} toastErr={toastErr} onSave={saveRule('dv')} onDelete={(id) => setExtra(doc, 'dv', tab.id, id, null)} onClose={() => setPanel(null)} />}
      {panel === 'names' && <NamesPanel names={nameList} selA1={selA1} onSave={saveName} onDelete={(key) => canEdit && setName(doc, key, null)} onClose={() => setPanel(null)} />}
      {panel === 'sort' && <SortPanel cols={blockCols()} onClose={() => setPanel(null)} onSort={({ header, keys }) => { const rect = dataRect(); sortRows({ ...rect, r1: header ? rect.r1 + 1 : rect.r1 }, keys); }} />}
      {panel === 'dedupe' && <DedupePanel cols={(() => { const rect = dataRect(); return Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => ({ c: rect.c1 + i, letter: colName(rect.c1 + i), head: shown(rect.r1, rect.c1 + i) })); })()} onClose={() => setPanel(null)} onRun={removeDuplicates} />}
      {panel === 'split' && <SplitPanel onClose={() => setPanel(null)} onRun={splitColumns} />}
    </div>
  );
}
