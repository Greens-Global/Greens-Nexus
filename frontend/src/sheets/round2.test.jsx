import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';

vi.mock('../ui/dialog', () => ({
  dialog: {
    confirm: vi.fn(() => Promise.resolve(true)),
    prompt: vi.fn(() => Promise.resolve('https://example.com/report')),
    alert: vi.fn(() => Promise.resolve()),
  },
}));

import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc } from './index.js';
import {
  buildCtx, writeCells, newTabSnapshot, insertLines, deleteLines, setExtra, setName, rangeIds, extraOf, cellsOf, readExtra, safeLink,
} from './model.js';
import { createEngine, isErr } from './formula/eval.js';
import { colIndex } from './formula/parse.js';
import { parseInput } from './format.js';
import {
  mergesOf, hiddenRows, conditionalStyler, validationAt, validValue, listItems, seriesNext, chartData, cycleRef, autoSum, fillTokens,
} from './features.js';
import { keyId } from './shortcuts.js';

const pos = (ref) => ({ r: Number(ref.match(/\d+/)[0]) - 1, c: colIndex(ref.match(/[A-Z]+/)[0]) });
function book(cells = {}, rows = 50, cols = 10) {
  const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Main', rows, cols)] };
  const doc = seedSheetDoc(snap);
  const tab = snap.tabs[0].id;
  writeCells(doc, tab, Object.entries(cells).map(([ref, val]) => { const p = parseInput(val); return { ...pos(ref), v: p.v, f: p.f }; }));
  return { doc, tab };
}
const valueAt = (doc, tab, ref, opts) => { const { r, c } = pos(ref); const v = createEngine(buildCtx(doc), opts).value(tab, r, c); return isErr(v) ? v.code : v; };
const cell = (doc, ref) => { const ctx = buildCtx(doc); const { r, c } = pos(ref); return ctx.cell(ctx.tabs[0], r, c); };

// ── keyboard shortcuts ───────────────────────────────────────────────────
function mount(cells = {}) {
  const { doc, tab } = book(cells, 1000, 26);
  const view = render(<SheetEditor doc={doc} canEdit title="T" me={{ email: 'pat@example.com', name: 'Pat Lee' }} />);
  const grid = screen.getByRole('grid');
  const at = (ref) => { const { r, c } = pos(ref); return view.container.querySelector(`[data-r="${r}"][data-c="${c}"]`); };
  const click = (ref, opts = {}) => { fireEvent.mouseDown(at(ref), { button: 0, ...opts }); fireEvent.mouseUp(window); };
  const key = (k) => {
    const parts = k.split('+'), last = parts.pop();
    const code = /^[A-Z]$/.test(last) ? 'Key' + last : /^\d$/.test(last) ? 'Digit' + last : last;
    const keyName = /^[A-Z]$/.test(last) ? last.toLowerCase() : /^\d$/.test(last) ? last : { Space: ' ', Semicolon: ';', Backquote: '`', Slash: '/', Minus: '-', Equal: '=' }[last] || last;
    act(() => { fireEvent.keyDown(grid, { key: keyName, code, ctrlKey: parts.includes('Mod'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') }); });
  };
  act(() => { grid.focus(); });
  return { doc, tab, grid, at, click, key, nameBox: () => screen.getByLabelText('Name Box').value };
}

describe('keyId', () => {
  it('names keys the way the table does', () => {
    expect(keyId({ key: 'b', code: 'KeyB', ctrlKey: true })).toBe('Mod+KeyB');
    expect(keyId({ key: '$', code: 'Digit4', metaKey: true, shiftKey: true })).toBe('Mod+Shift+Digit4');
    expect(keyId({ key: '≠', code: 'Equal', altKey: true })).toBe('Alt+Equal');
    expect(keyId({ key: 'F2', code: 'F2', shiftKey: true })).toBe('Shift+F2');
  });
});

describe('shortcuts', () => {
  const style = (doc, ref) => cell(doc, ref)?.s || {};
  it.each([
    ['Mod+B', {}, 'A1', (t) => expect(style(t.doc, 'A1').b).toBe(true)],
    ['Mod+I', {}, 'A1', (t) => expect(style(t.doc, 'A1').i).toBe(true)],
    ['Mod+U', {}, 'A1', (t) => expect(style(t.doc, 'A1').u).toBe(true)],
    ['Mod+5', {}, 'A1', (t) => expect(style(t.doc, 'A1').st).toBe(true)],
    ['Mod+Shift+4', { A1: '5' }, 'A1', (t) => expect(style(t.doc, 'A1').nf).toBe('currency')],
    ['Mod+Shift+5', { A1: '5' }, 'A1', (t) => expect(style(t.doc, 'A1').nf).toBe('percent')],
    ['Mod+Shift+3', { A1: '5' }, 'A1', (t) => expect(style(t.doc, 'A1').nf).toBe('date')],
    ['Mod+Shift+2', { A1: '5' }, 'A1', (t) => expect(style(t.doc, 'A1').nf).toBe('time')],
    ['Mod+Shift+1', { A1: '5' }, 'A1', (t) => expect(style(t.doc, 'A1').nf).toBe('number')],
    ['Mod+Shift+7', {}, 'A1', (t) => expect(style(t.doc, 'A1')).toMatchObject({ bt: 'thin #000000', bb: 'thin #000000', bl: 'thin #000000', br: 'thin #000000' })],
    ['Mod+Semicolon', {}, 'A1', (t) => { expect(Number.isInteger(cell(t.doc, 'A1').v)).toBe(true); expect(style(t.doc, 'A1').nf).toBe('date'); }],
    ['Mod+Shift+Semicolon', {}, 'A1', (t) => { expect(cell(t.doc, 'A1').v).toBeLessThan(1); expect(style(t.doc, 'A1').nf).toBe('time'); }],
    ['Mod+9', {}, 'A3', (t) => expect(buildCtx(t.doc).tabs[0].hidden.has(buildCtx(t.doc).tabs[0].rows[2])).toBe(true)],
    ['Mod+0', {}, 'C1', (t) => expect(buildCtx(t.doc).tabs[0].hidden.has(buildCtx(t.doc).tabs[0].cols[2])).toBe(true)],
    ['Shift+F11', {}, 'A1', (t) => expect(buildCtx(t.doc).tabs).toHaveLength(2)],
    ['Mod+Shift+L', { A1: 'Name', A2: 'x' }, 'A1', (t) => expect(buildCtx(t.doc).tabs[0].filter.get('f')).toBeTruthy()],
    ['Mod+A', {}, 'B2', (t) => expect(t.nameBox()).toBe('A1:Z1000')],
    ['Mod+Space', {}, 'B2', (t) => expect(t.nameBox()).toBe('B1:B1000')],
    ['Shift+Space', {}, 'B2', (t) => expect(t.nameBox()).toBe('A2:Z2')],
    ['Mod+End', { D7: 'x' }, 'A1', (t) => expect(t.nameBox()).toBe('D7')],
    ['Mod+Home', {}, 'D7', (t) => expect(t.nameBox()).toBe('A1')],
    ['Mod+Shift+ArrowDown', { A1: '1', A2: '2', A3: '3' }, 'A1', (t) => expect(t.nameBox()).toBe('A1:A3')],
    ['Mod+Slash', {}, 'A1', () => expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeTruthy()],
    ['Mod+1', {}, 'A1', () => expect(screen.getByRole('dialog', { name: 'Format Cells' })).toBeTruthy()],
    ['Mod+F', {}, 'A1', () => expect(screen.getByLabelText('Find in this tab')).toBeTruthy()],
    ['Mod+H', {}, 'A1', () => expect(screen.getByLabelText('Replace with')).toBeTruthy()],
    ['Mod+Alt+M', {}, 'A1', () => expect(screen.getByRole('dialog', { name: 'Note' })).toBeTruthy()],
    ['Shift+F2', {}, 'A1', () => expect(screen.getByRole('dialog', { name: 'Note' })).toBeTruthy()],
    ['Alt+Equal', { A1: '1', A2: '2' }, 'A3', () => expect(screen.getByLabelText('Edit A3').value).toBe('=SUM(A1:A2)')],
    ['Mod+Backquote', { A1: '2', A2: '=A1*2' }, 'A1', () => expect(screen.getByText('=A1*2', { selector: '.nxs-text' })).toBeTruthy()],
    ['F2', { A1: '7' }, 'A1', () => expect(screen.getByLabelText('Edit A1').value).toBe('7')],
  ])('%s', (combo, cells, start, check) => {
    const t = mount(cells);
    t.click(start);
    t.key(combo);
    check(t);
  });

  it('Mod+Z undoes and Mod+Y redoes', () => {
    const t = mount();
    t.click('A1'); t.key('Mod+B');
    t.key('Mod+Z');
    expect(cell(t.doc, 'A1')?.s?.b).toBeFalsy();
    t.key('Mod+Y');
    expect(cell(t.doc, 'A1').s.b).toBe(true);
  });
  it('Mod+Shift+Backquote and Mod+Shift+Minus undo formats', () => {
    const t = mount({ A1: '5' });
    t.click('A1'); t.key('Mod+Shift+4'); t.key('Mod+Shift+7');
    t.key('Mod+Shift+Backquote'); t.key('Mod+Shift+Minus');
    expect(cell(t.doc, 'A1').s).toBeUndefined();
  });
  it('Mod+Shift+9 / 0 unhide what Mod+9 / 0 hid', () => {
    const t = mount();
    t.click('B2'); t.key('Mod+9'); t.key('Mod+0');
    t.click('A1'); t.click('C3', { shiftKey: true });
    t.key('Mod+Shift+9'); t.key('Mod+Shift+0');
    expect(buildCtx(t.doc).tabs[0].hidden.size).toBe(0);
  });
  it('Mod+D and Mod+R fill from the first row and column', () => {
    const t = mount({ A1: '5', B1: '=A1*2' });
    t.click('A1'); t.click('B3', { shiftKey: true }); t.key('Mod+D');
    expect(valueAt(t.doc, t.tab, 'A3')).toBe(5);
    expect(valueAt(t.doc, t.tab, 'B3')).toBe(10);
    t.click('A1'); t.click('C1', { shiftKey: true }); t.key('Mod+R');
    expect(valueAt(t.doc, t.tab, 'C1')).toBe(5);   // A1's 5 copied across B1 and C1
  });
  it('Mod+Minus asks, then deletes whole rows; Mod+Shift+Equal inserts', async () => {
    const t = mount({ A2: 'keep' });
    t.click('A1'); t.key('Shift+Space');
    await act(async () => { t.key('Mod+Minus'); await Promise.resolve(); await Promise.resolve(); });
    const { dialog } = await import('../ui/dialog');
    expect(dialog.confirm).toHaveBeenCalledWith(expect.stringContaining('Delete row 1'), expect.objectContaining({ danger: true }));
    expect(buildCtx(t.doc).tabs[0].rows).toHaveLength(999);
    expect(cell(t.doc, 'A1').v).toBe('keep');
    t.key('Mod+Shift+Equal');
    expect(buildCtx(t.doc).tabs[0].rows).toHaveLength(1000);
  });
  it('Mod+K sets a safe link', async () => {
    const t = mount({ A1: 'Report' });
    t.click('A1');
    await act(async () => { t.key('Mod+K'); await Promise.resolve(); await Promise.resolve(); });
    expect(cell(t.doc, 'A1').l).toBe('https://example.com/report');
  });
  it('Mod+PageDown and Alt+ArrowDown step tabs', () => {
    const t = mount();
    t.key('Shift+F11');
    t.click('A1');
    t.key('Mod+PageUp');
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
    t.key('Alt+ArrowDown');
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
  });
  it('editing: Alt+Enter, F4 and Ctrl+Enter', () => {
    const t = mount({ A1: '1' });
    t.click('B1'); t.key('F2');
    const input = screen.getByLabelText('Edit B1');
    fireEvent.change(input, { target: { value: '=A1' } });
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: 'F4', code: 'F4' });
    expect(screen.getByLabelText('Edit B1').value).toBe('=$A$1');
    fireEvent.keyDown(screen.getByLabelText('Edit B1'), { key: 'Escape' });
    // Ctrl+Enter writes the entry into every selected cell, re-aimed.
    t.click('C1'); t.click('C3', { shiftKey: true });
    t.key('F2');
    const ed = screen.getByLabelText('Edit C1');
    fireEvent.change(ed, { target: { value: '=ROW()' } });
    fireEvent.keyDown(ed, { key: 'Enter', ctrlKey: true });
    expect(valueAt(t.doc, t.tab, 'C3')).toBe(3);
    // Alt+Enter: a line break, and the cell wraps.
    t.click('D1'); t.key('F2');
    const d = screen.getByLabelText('Edit D1');
    fireEvent.change(d, { target: { value: 'one' } });
    d.setSelectionRange(3, 3);
    fireEvent.keyDown(d, { key: 'Enter', altKey: true });
    fireEvent.change(screen.getByLabelText('Edit D1'), { target: { value: 'one\ntwo' } });
    fireEvent.keyDown(screen.getByLabelText('Edit D1'), { key: 'Enter' });
    expect(cell(t.doc, 'D1')).toEqual({ v: 'one\ntwo', s: { wrap: true } });
  });
});

// ── merges ───────────────────────────────────────────────────────────────
describe('merges', () => {
  it('follow concurrent inserts and render once', () => {
    const { doc, tab } = book({ A1: 'Title' });
    const ctx = buildCtx(doc);
    const t = ctx.tabs[0];
    setExtra(doc, 'merges', tab, `${t.rows[0]}.${t.cols[0]}`, { r2: t.rows[1], c2: t.cols[2] });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    insertLines(doc, tab, 'rows', 1, 1);       // inside the merge: it grows
    insertLines(other, tab, 'cols', 0, 1);     // left of it: it moves
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    for (const d of [doc, other]) {
      const c2 = buildCtx(d);
      expect(mergesOf(c2, c2.tabs[0])).toEqual([{ r1: 0, c1: 1, r2: 2, c2: 3 }]);
    }
    deleteLines(doc, tab, 'rows', 0, 1);     // the corner row goes: so does the merge
    expect(mergesOf(buildCtx(doc), buildCtx(doc).tabs[0])).toEqual([]);
  });
  it('draws a merged block once at its full size', () => {
    const { doc, tab } = book({ A1: 'Wide' });
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'merges', tab, `${t.rows[0]}.${t.cols[0]}`, { r2: t.rows[0], c2: t.cols[2] });
    const view = render(<SheetEditor doc={doc} canEdit title="T" />);
    expect(view.container.querySelector('[data-r="0"][data-c="1"]')).toBeNull();
    expect(view.container.querySelector('[data-r="0"][data-c="0"]').style.width).toBe('300px');
  });
});

// ── filter, conditional formats, validation ─────────────────────────────
describe('filter', () => {
  it('hides the rows a column filter leaves out', () => {
    const { doc, tab } = book({ A1: 'Status', A2: 'Open', A3: 'Done', A4: 'Open', B1: 'Amount', B2: '5', B3: '50', B4: '500' });
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'filter', tab, 'f', { r: t.rows[0], c1: t.cols[0], c2: t.cols[1], crit: { [t.cols[0]]: { hide: ['Done'] }, [t.cols[1]]: { op: 'gt', a: '10' } } });
    const ctx = buildCtx(doc);
    expect([...hiddenRows(ctx, createEngine(ctx), ctx.tabs[0])].sort()).toEqual([1, 2]);
  });
});

describe('conditional formats', () => {
  it('first matching rule wins; scales and custom formulas work', () => {
    const { doc, tab } = book({ A1: '1', A2: '5', A3: '10', B1: '3', B2: '9' });
    const t = buildCtx(doc).tabs[0];
    const range = rangeIds(t, { r1: 0, c1: 0, r2: 2, c2: 0 });
    setExtra(doc, 'cf', tab, 'r1', { range, type: 'gt', a: 4, style: { bg: '#fee2e2' }, order: 1 });
    setExtra(doc, 'cf', tab, 'r2', { range, type: 'gt', a: 8, style: { bg: '#dcfce7' }, order: 2 });
    setExtra(doc, 'cf', tab, 'r3', { range: rangeIds(t, { r1: 0, c1: 1, r2: 1, c2: 1 }), type: 'formula', f: '=B1>A1*2', style: { b: true }, order: 3 });
    let ctx = buildCtx(doc);
    let fmt = conditionalStyler(ctx, createEngine(ctx), ctx.tabs[0]);
    expect(fmt(0, 0)).toBeNull();
    expect(fmt(1, 0)).toEqual({ bg: '#fee2e2' });
    expect(fmt(2, 0)).toEqual({ bg: '#fee2e2' });
    expect(fmt(0, 1)).toEqual({ b: true });       // 3 > 2
    expect(fmt(1, 1)).toBeNull();                 // 9 > 10? no
    setExtra(doc, 'cf', tab, 'r1', null); setExtra(doc, 'cf', tab, 'r2', null);
    setExtra(doc, 'cf', tab, 's', { range, type: 'scale', colors: ['#ffffff', '#000000'] });
    ctx = buildCtx(doc);
    fmt = conditionalStyler(ctx, createEngine(ctx), ctx.tabs[0]);
    expect(fmt(0, 0)).toEqual({ bg: '#ffffff' });
    expect(fmt(2, 0)).toEqual({ bg: '#000000' });
  });
});

describe('data validation', () => {
  it('checks lists, ranges, numbers, dates and checkboxes', () => {
    const { doc, tab } = book({ D1: 'Red', D2: 'Blue' });
    const t = buildCtx(doc).tabs[0];
    const one = (ref) => rangeIds(t, { r1: pos(ref).r, c1: pos(ref).c, r2: pos(ref).r, c2: pos(ref).c });
    setExtra(doc, 'dv', tab, 'a', { range: one('A1'), kind: 'list', items: ['Open', 'Done'], reject: true });
    setExtra(doc, 'dv', tab, 'b', { range: one('B1'), kind: 'range', src: `=@[${t.rows[0]},${t.cols[3]}:${t.rows[1]},${t.cols[3]}]` });
    setExtra(doc, 'dv', tab, 'c', { range: one('C1'), kind: 'number', op: 'between', a: 1, b: 10 });
    setExtra(doc, 'dv', tab, 'e', { range: one('E1'), kind: 'date', op: 'gte', a: '11/01/2026' });
    const ctx = buildCtx(doc), eng = createEngine(ctx), tt = ctx.tabs[0];
    const rule = (ref) => validationAt(ctx, tt, pos(ref).r, pos(ref).c);
    expect(validValue(rule('A1'), 'open', eng, ctx, tt)).toBe(true);
    expect(validValue(rule('A1'), 'Later', eng, ctx, tt)).toBe(false);
    expect(listItems(rule('B1'), eng, ctx, tt)).toEqual(['Red', 'Blue']);
    expect(validValue(rule('C1'), 11, eng, ctx, tt)).toBe(false);
    expect(validValue(rule('C1'), 3, eng, ctx, tt)).toBe(true);
    expect(validValue(rule('E1'), parseInput('10/31/2026').v, eng, ctx, tt)).toBe(false);
    expect(validValue(rule('A1'), null, eng, ctx, tt)).toBe(true);
  });
  it('a reject rule refuses a typed value', () => {
    const { doc, tab } = book();
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'dv', tab, 'a', { range: rangeIds(t, { r1: 0, c1: 0, r2: 0, c2: 0 }), kind: 'list', items: ['Yes', 'No'], reject: true });
    const toastErr = vi.fn();
    render(<SheetEditor doc={doc} canEdit title="T" toastErr={toastErr} />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    fireEvent.keyDown(grid, { key: 'M' });
    const ed = screen.getByLabelText('Edit A1');
    fireEvent.change(ed, { target: { value: 'Maybe' } });
    fireEvent.keyDown(ed, { key: 'Enter' });
    expect(cell(doc, 'A1')).toBeUndefined();
    expect(toastErr).toHaveBeenCalled();
  });
});

// ── names, spill, functions, variables ──────────────────────────────────
describe('named ranges', () => {
  it('are usable in formulas and follow their cells', () => {
    const { doc, tab } = book({ B2: '10', B3: '20', C1: '=SUM(Sales)', C2: '=Rate*2', D1: '0.5' });
    const t = buildCtx(doc).tabs[0];
    setName(doc, 'sales', { name: 'Sales', tab, range: rangeIds(t, { r1: 1, c1: 1, r2: 2, c2: 1 }) });
    setName(doc, 'rate', { name: 'Rate', tab, range: rangeIds(t, { r1: 0, c1: 3, r2: 0, c2: 3 }) });
    expect(valueAt(doc, tab, 'C1')).toBe(30);
    expect(valueAt(doc, tab, 'C2')).toBe(1);
    insertLines(doc, tab, 'rows', 0, 2);
    expect(valueAt(doc, tab, 'C3')).toBe(30);
  });
});

describe('spill', () => {
  it('fills neighbors, and reads #SPILL! when blocked', () => {
    const { doc, tab } = book({ A1: '3', A2: '1', A3: '2', A4: '1', B1: '=SORT(A1:A4)', C1: '=UNIQUE(A1:A4)', D1: '=SEQUENCE(2,3)', H1: '=A1:A3*10' });
    expect([1, 2, 3, 4].map((i) => valueAt(doc, tab, 'B' + i))).toEqual([1, 1, 2, 3]);
    expect([1, 2, 3, 4].map((i) => valueAt(doc, tab, 'C' + i))).toEqual([3, 1, 2, null]);
    expect(valueAt(doc, tab, 'F2')).toBe(6);
    expect(valueAt(doc, tab, 'H3')).toBe(20);
    writeCells(doc, tab, [{ ...pos('E2'), v: 'x' }]);
    expect(valueAt(doc, tab, 'D1')).toBe('#SPILL!');
    expect(valueAt(doc, tab, 'F2')).toBe(null);
  });
  it('FILTER keeps matching rows and others may read the spill', () => {
    const { doc, tab } = book({ A1: 'a', A2: 'b', A3: 'c', B1: '1', B2: '5', B3: '9', D1: '=FILTER(A1:B3,B1:B3>2)', G1: '=SUM(E1:E5)' });
    expect(valueAt(doc, tab, 'D1')).toBe('b');
    expect(valueAt(doc, tab, 'E2')).toBe(9);
    expect(valueAt(doc, tab, 'G1')).toBe(14);
  });
});

describe('more functions', () => {
  const ev = (f, cells = {}) => { const { doc, tab } = book({ ...cells, J50: f }); return valueAt(doc, tab, 'J50'); };
  const data = { A1: '2', A2: '4', A3: '4', A4: '5', A5: '9', B1: 'x', C1: '=1+1' };
  it.each([
    ['=ROUND(STDEV.S(A1:A5),4)', 2.5884], ['=ROUND(STDEV.P(A1:A5),4)', 2.3152], ['=ROUND(VAR.S(A1:A5),4)', 6.7], ['=ROUND(VAR(A1:A5),4)', 6.7],
    ['=ROUND(VAR.P(A1:A5),4)', 5.36], ['=ROUND(STDEV(A1:A5),4)', 2.5884],
    ['=LARGE(A1:A5,2)', 5], ['=SMALL(A1:A5,1)', 2], ['=RANK(5,A1:A5)', 2], ['=PERCENTILE(A1:A5,0.5)', 4], ['=QUARTILE(A1:A5,1)', 4],
    ['=MODE(A1:A5)', 4], ['=MROUND(17,5)', 15], ['=TRUNC(-2.7)', -2], ['=ROUND(EXP(1),4)', 2.7183], ['=LN(1)', 0], ['=LOG(1000)', 3],
    ['=LOG10(100)', 2], ['=FACT(5)', 120], ['=GCD(12,18)', 6], ['=LCM(4,6)', 12], ['=ISEVEN(4)', true], ['=ISODD(4)', false],
    ['=ISFORMULA(C1)', true], ['=ISFORMULA(A1)', false], ['=ISLOGICAL(TRUE)', true], ['=N(B1)', 0], ['=T(B1)', 'x'],
    ['=COUNTUNIQUE(A1:A5)', 4], ['=AVERAGEA(A1:B1)', 1], ['=TEXTBEFORE("a-b-c","-")', 'a'], ['=TEXTAFTER("a-b-c","-",2)', 'c'],
    ['=JOIN(", ",A1:A3)', '2, 4, 4'], ['=INDIRECT("A5")', 9], ['=SUM(OFFSET(A1,1,0,2,1))', 8], ['=LET(x,3,y,4,x*y)', 12],
    ['=ARRAYFORMULA(SUM(A1:A2*2))', 12], ['=INDEX(SPLIT("1,2,3",","),1,2)', 2], ['=ROWS(TRANSPOSE(A1:A5))', 1],
    ['=WORKDAY(DATE(2026,11,6),1)', 46335], ['=WEEKNUM(DATE(2026,11,5))', 45], ['=ISOWEEKNUM(DATE(2026,11,5))', 45],
    ['=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1))', 0.5], ['=TIME(12,0,0)', 0.5], ['=SECOND(TIME(1,2,3))', 3],
    ['=DATEVALUE("11/05/2026")', 46331], ['=ROUND(TIMEVALUE("6:00 PM"),4)', 0.75], ['=HYPERLINK("https://x.com","Site")', 'Site'],
    ['=VLOOKUP(9,A1:A5,1,FALSE)', 9], ['=VLOOKUP(10,A1:A5,1,FALSE)', '#N/A'], ['=VLOOKUP(9,A1:A5,2,FALSE)', '#REF!'],
    ['=IFERROR(VLOOKUP(10,A1:A5,1,FALSE),"none")', 'none'], ['=SUM(IF(A1:A5>4,1,0))', 2],
  ])('%s', (f, want) => { expect(ev(f, data)).toBe(want); });
});

describe('variables', () => {
  const vars = { tokens: new Set(['full_name', 'salary', 'start_date']), values: { full_name: 'Pat Lee', salary: '85000', start_date: '' } };
  it('VAR reads a value, a number, #N/A with a note, #NAME? for an unknown token', () => {
    const { doc, tab } = book({ A1: '=VAR("full_name")', A2: '=VAR("salary")*2', A3: '=VAR("start_date")', A4: '=VAR("nope")' });
    expect(valueAt(doc, tab, 'A1', { vars })).toBe('Pat Lee');
    expect(valueAt(doc, tab, 'A2', { vars })).toBe(170000);
    const ctx = buildCtx(doc);
    const na = createEngine(ctx, { vars }).value(tab, 2, 0);
    expect(na.code).toBe('#N/A');
    expect(na.note).toBe('Pick a person or company for this sheet');
    expect(valueAt(doc, tab, 'A4', { vars })).toBe('#NAME?');
  });
  it('{{tokens}} in text show their values; the stored text keeps the token', () => {
    expect(fillTokens('Dear {{full_name}}, from {{company_name}}', { full_name: 'Pat' }).text).toBe('Dear Pat, from {{company_name}}');
    const { doc } = book({ A1: 'Hi {{full_name}}' });
    render(<SheetEditor doc={doc} canEdit title="T" variables={[{ token: 'full_name', label: 'Full Name', group: 'Person' }]} variableValues={{ full_name: 'Pat Lee' }} />);
    expect(screen.getByText('Pat Lee', { selector: '.nxs-var' })).toBeTruthy();
    expect(screen.getByLabelText('Formula Bar').value).toBe('Hi {{full_name}}');
    expect(cell(doc, 'A1').v).toBe('Hi {{full_name}}');
  });
  it('recalculates when the values change', () => {
    const { doc } = book({ A1: '=VAR("full_name")' });
    const variables = [{ token: 'full_name', label: 'Full Name', group: 'Person' }];
    const view = render(<SheetEditor doc={doc} canEdit title="T" variables={variables} variableValues={{ full_name: 'Pat' }} />);
    expect(screen.getAllByText('Pat').length).toBeGreaterThan(0);
    view.rerender(<SheetEditor doc={doc} canEdit title="T" variables={variables} variableValues={{ full_name: 'Sam' }} />);
    expect(screen.getAllByText('Sam').length).toBeGreaterThan(0);
  });
  it('the picker inserts =VAR("token")', () => {
    const { doc } = book();
    render(<SheetEditor doc={doc} canEdit title="T" variables={[{ token: 'company_name', label: 'Company Name', group: 'Company' }]} variableValues={{}} />);
    fireEvent.click(screen.getByLabelText('Insert a Variable'));
    fireEvent.click(screen.getByText('Company Name'));
    expect(cell(doc, 'A1').f).toBe('=VAR("company_name")');
  });
});

// ── charts, fill, helpers, validation of stored state ───────────────────
describe('chart data', () => {
  it('reads categories from text and series from the header row', () => {
    const { doc, tab } = book({ A1: 'Month', B1: 'Rent', C1: 'Fees', A2: 'Jan', B2: '100', C2: '10', A3: 'Feb', B3: '120', C3: '' });
    const ctx = buildCtx(doc);
    const data = chartData(createEngine(ctx), ctx, ctx.tabs[0], { r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(data.categories).toEqual(['Jan', 'Feb']);
    expect(data.series).toEqual([{ name: 'Rent', values: [100, 120], nf: '' }, { name: 'Fees', values: [10, null], nf: '' }]);
    void tab;
  });
});

describe('smart fill', () => {
  const c = (v, nf) => ({ v, ...(nf ? { s: { nf } } : {}) });
  it('continues numbers, dates, days, months, quarters and numbered text', () => {
    expect(seriesNext([c(1), c(2)], 3)).toEqual([3, 4, 5]);
    expect(seriesNext([c(5)], 2)).toBeNull();
    expect(seriesNext([c(46331, 'date')], 2)).toEqual([46332, 46333]);
    expect(seriesNext([c('Mon')], 3)).toEqual(['Tue', 'Wed', 'Thu']);
    expect(seriesNext([c('Friday')], 2)).toEqual(['Saturday', 'Sunday']);
    expect(seriesNext([c('Nov')], 3)).toEqual(['Dec', 'Jan', 'Feb']);
    expect(seriesNext([c('Q3')], 2)).toEqual(['Q4', 'Q1']);
    expect(seriesNext([c('Item 1')], 2)).toEqual(['Item 2', 'Item 3']);
    expect(seriesNext([c('Unit 008')], 1)).toEqual(['Unit 009']);
    expect(seriesNext([c(3), c(6)], 2, true)).toEqual([0, -3]);
    expect(seriesNext([c('plain')], 2)).toBeNull();
  });
});

describe('editing helpers', () => {
  it('cycles $ with F4 and builds AutoSum', () => {
    expect(cycleRef('=A1+B2', 3).text).toBe('=$A$1+B2');
    expect(cycleRef('=$A$1', 5).text).toBe('=A$1');
    expect(cycleRef('=A$1', 4).text).toBe('=$A1');
    expect(cycleRef('=$A1', 4).text).toBe('=A1');
    const { doc, tab } = book({ B1: '1', B2: '2', A4: '3' });
    const ctx = buildCtx(doc);
    expect(autoSum(createEngine(ctx), ctx.tabs[0], 2, 1)).toBe('=SUM(B1:B2)');
    expect(autoSum(createEngine(ctx), ctx.tabs[0], 3, 1)).toBe('=SUM(A4:A4)');
    void tab;
  });
});

describe('stored state checks', () => {
  it('round-trips every new structure and refuses bad ones', () => {
    const { doc, tab } = book({ A1: 'x' });
    const t = buildCtx(doc).tabs[0];
    const g = rangeIds(t, { r1: 0, c1: 0, r2: 1, c2: 1 });
    setExtra(doc, 'merges', tab, `${t.rows[0]}.${t.cols[0]}`, { r2: t.rows[1], c2: t.cols[1] });
    setExtra(doc, 'notes', tab, `${t.rows[0]}.${t.cols[0]}`, { text: 'Check this', by: 'Pat', at: '2026-11-05T10:00:00Z' });
    setExtra(doc, 'charts', tab, 'ch1', { type: 'pie', range: g, x: 10, y: 10, w: 400, h: 300 });
    setExtra(doc, 'cf', tab, 'cf1', { range: g, type: 'empty', style: { bg: '#ffffff' } });
    setExtra(doc, 'dv', tab, 'dv1', { range: g, kind: 'checkbox' });
    setExtra(doc, 'hidden', tab, t.rows[5], true);
    setName(doc, 'top', { name: 'Top', tab, range: g });
    writeCells(doc, tab, [{ r: 2, c: 2, v: 'site', l: 'https://example.com/' }]);
    expect(() => validateSheetDoc(doc)).not.toThrow();
    const snap = snapshotOf(doc);
    expect(snapshotOf(seedSheetDoc(snap))).toEqual(snap);
    const bad = (fn) => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(doc)); fn(d); return () => validateSheetDoc(d); };
    expect(bad((d) => cellsOf(d, tab).set(`${t.rows[3]}.${t.cols[3]}`, { v: 'x', l: 'javascript:alert(1)' }))).toThrow();
    expect(bad((d) => extraOf(d, 'cf', tab).set('x', { range: g, type: 'gt', style: { bg: 'url(http://evil)' } }))).toThrow();
    expect(bad((d) => extraOf(d, 'charts', tab).set('x', { type: 'pie', range: g, x: 0, y: 0, w: 99999, h: 300 }))).toThrow();
    expect(bad((d) => extraOf(d, 'notes', tab).set('bad', { text: 'x' }))).toThrow();
    expect(bad((d) => d.getMap('names').set('a1', { name: 'A1', tab, range: g }))).toThrow();
    expect(bad((d) => extraOf(d, 'dv', tab).set('x', { range: g, kind: 'list', items: ['a'.repeat(201)] }))).toThrow();
    // A bad live edit is dropped on read rather than shown.
    extraOf(doc, 'cf', tab).set('evil', { range: g, type: 'gt', style: { bg: 'url(x)' } });
    expect(readExtra(doc, 'cf', tab).has('evil')).toBe(false);
    expect(safeLink('javascript:alert(1)')).toBe('');
    expect(safeLink('mailto:pat@example.com')).toBe('mailto:pat@example.com');
  });
});
