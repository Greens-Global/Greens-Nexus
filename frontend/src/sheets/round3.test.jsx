import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';

vi.mock('../ui/dialog', () => ({
  dialog: {
    confirm: vi.fn(() => Promise.resolve(true)),
    prompt: vi.fn(() => Promise.resolve('https://example.com')),
    alert: vi.fn(() => Promise.resolve()),
  },
}));

import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc, exportSheetFile } from './index.js';
import { buildCtx, writeCells, newTabSnapshot, setExtra, extraOf, rangeIds, LIMITS, cellsOf } from './model.js';
import { createEngine, isErr } from './formula/eval.js';
import { colIndex } from './formula/parse.js';
import { parseInput } from './format.js';
import { mergesOf, mergeAt, chartData, CHART_POINTS } from './features.js';
import { dialog } from '../ui/dialog';

const pos = (ref) => ({ r: Number(ref.match(/\d+/)[0]) - 1, c: colIndex(ref.match(/[A-Z]+/)[0]) });
function book(cells = {}, rows = 60, cols = 10) {
  const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Main', rows, cols)] };
  const doc = seedSheetDoc(snap);
  const tab = snap.tabs[0].id;
  writeCells(doc, tab, Object.entries(cells).map(([ref, val]) => { const p = parseInput(val); return { ...pos(ref), v: p.v, f: p.f }; }));
  return { doc, tab };
}
const value = (eng, tab, ref) => { const { r, c } = pos(ref); const v = eng.value(tab, r, c); return isErr(v) ? v.code : v; };
const cell = (doc, ref) => { const ctx = buildCtx(doc); const { r, c } = pos(ref); return ctx.cell(ctx.tabs[0], r, c); };
function mount(cells, props = {}) {
  const { doc, tab } = book(cells, 100, 10);
  const view = render(<SheetEditor doc={doc} canEdit title="T" {...props} />);
  const grid = screen.getByRole('grid');
  const at = (ref) => { const { r, c } = pos(ref); return view.container.querySelector(`[data-r="${r}"][data-c="${c}"]`); };
  const click = (ref, opts = {}) => { fireEvent.mouseDown(at(ref), { button: 0, ...opts }); fireEvent.mouseUp(window); };
  act(() => { grid.focus(); });
  return { doc, tab, grid, at, click };
}
afterEach(() => { vi.clearAllMocks(); });

describe('limits never lock a sheet', () => {
  it('201 formatting rules: saves 200, reopens, and the UI refuses the 201st', () => {
    const { doc, tab } = book({ A1: '1' });
    const t = buildCtx(doc).tabs[0];
    const range = rangeIds(t, { r1: 0, c1: 0, r2: 0, c2: 0 });
    for (let i = 0; i < 201; i += 1) extraOf(doc, 'cf', tab).set(`r${i}`, { range, type: 'gt', a: i, style: { b: true } });
    expect(() => validateSheetDoc(doc)).not.toThrow();
    const snap = snapshotOf(doc);
    expect(Object.keys(snap.tabs[0].cf)).toHaveLength(LIMITS.cf);
    const reopened = seedSheetDoc(snap);
    expect(() => validateSheetDoc(reopened)).not.toThrow();
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(() => validateSheetDoc(copy)).not.toThrow();
  });
  it('the rules panel refuses a rule past the limit', async () => {
    const toastErr = vi.fn();
    const t = mount({}, { toastErr });
    const tb = buildCtx(t.doc).tabs[0];
    const range = rangeIds(tb, { r1: 0, c1: 0, r2: 0, c2: 0 });
    act(() => { for (let i = 0; i < LIMITS.cf; i += 1) extraOf(t.doc, 'cf', t.tab).set(`r${i}`, { range, type: 'gt', a: i, style: { b: true } }); });
    fireEvent.click(screen.getByTitle('Format'));
    fireEvent.click(screen.getByText('Conditional Formatting'));
    fireEvent.click(screen.getByText('Add Rule'));
    expect(toastErr).toHaveBeenCalledWith(expect.stringContaining('at most'));
    expect(extraOf(t.doc, 'cf', t.tab).size).toBe(LIMITS.cf);
  });
  it('a format over a huge area touches only cells that exist', () => {
    const { doc, tab } = book({ A1: 'x', B500: 'y' }, 1000, 200);
    const toastErr = vi.fn();
    render(<SheetEditor doc={doc} canEdit title="T" toastErr={toastErr} />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    fireEvent.keyDown(grid, { key: 'a', code: 'KeyA', ctrlKey: true });   // 200,000 cells
    fireEvent.keyDown(grid, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(cellsOf(doc, tab).size).toBe(2);
    expect(cell(doc, 'B500').s.b).toBe(true);
    expect(toastErr).toHaveBeenCalled();
  });
});

describe('spill does not depend on what is asked first', () => {
  const cells = { A1: '1', A2: '7', A3: '9', C1: '=FILTER(A1:A5,A1:A5>5)' };
  it('origin first', () => {
    const { doc, tab } = book(cells);
    const eng = createEngine(buildCtx(doc));
    expect(value(eng, tab, 'C1')).toBe(7);
    expect(value(eng, tab, 'C2')).toBe(9);
  });
  it('spilled cell first', () => {
    const { doc, tab } = book(cells);
    const eng = createEngine(buildCtx(doc));
    expect(value(eng, tab, 'C2')).toBe(9);
    expect(value(eng, tab, 'C1')).toBe(7);
    expect(value(eng, tab, 'C3')).toBe(null);
  });
});

describe('big data stays safe', () => {
  it('MAX over a long array does not overflow, charts stop at CHART_POINTS', () => {
    const { doc, tab } = book({ A1: '=MAX(SEQUENCE(100000))', B1: '=MIN(SEQUENCE(100000,1,-1,-1))' });
    const eng = createEngine(buildCtx(doc));
    expect(value(eng, tab, 'A1')).toBe(100000);
    expect(value(eng, tab, 'B1')).toBe(-100000);
    const big = book({}, 20000, 3);
    const ctx = buildCtx(big.doc);
    const data = chartData(createEngine(ctx), ctx, ctx.tabs[0], { r1: 0, c1: 0, r2: 19999, c2: 1 });
    expect(data.series.reduce((s, x) => s + x.values.length, 0)).toBeLessThanOrEqual(CHART_POINTS + 2);
  });
  it('SEARCH with many wildcards finishes quickly', () => {
    const { doc, tab } = book({ A1: '=SEARCH("*a*a*a*a*a*a*a*b",REPT("a",20000))', A2: '=SEARCH("b?d","abcd")', A3: '=COUNTIF(B1:B3,"x*z")', B1: 'xyz', B2: 'xz', B3: 'xza' });
    const t0 = Date.now();
    const eng = createEngine(buildCtx(doc));
    expect(value(eng, tab, 'A1')).toBe('#VALUE!');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(value(eng, tab, 'A2')).toBe(2);
    expect(value(eng, tab, 'A3')).toBe(2);
  });
  it('the merge index finds short and tall merges', () => {
    const { doc, tab } = book({}, 600, 5);
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'merges', tab, `${t.rows[0]}.${t.cols[0]}`, { r2: t.rows[1], c2: t.cols[1] });
    setExtra(doc, 'merges', tab, `${t.rows[5]}.${t.cols[3]}`, { r2: t.rows[500], c2: t.cols[3] });
    const ctx = buildCtx(doc);
    const list = mergesOf(ctx, ctx.tabs[0]);
    expect(mergeAt(list, 1, 1)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(mergeAt(list, 400, 3)).toEqual({ r1: 5, c1: 3, r2: 500, c2: 3 });
    expect(mergeAt(list, 2, 2)).toBeNull();
  });
});

describe('a filter protects the rows it hides', () => {
  function filtered() {
    const t = mount({ A1: 'Status', A2: 'Open', A3: 'Done', A4: 'Open', B2: '1', B3: '2', B4: '3' });
    const tb = buildCtx(t.doc).tabs[0];
    act(() => { setExtra(t.doc, 'filter', t.tab, 'f', { r: tb.rows[0], c1: tb.cols[0], c2: tb.cols[1], crit: { [tb.cols[0]]: { hide: ['Done'] } } }); });
    return t;
  }
  it('Delete skips them', () => {
    const t = filtered();
    t.click('A2'); t.click('B4', { shiftKey: true });
    fireEvent.keyDown(t.grid, { key: 'Delete' });
    expect(cell(t.doc, 'A3').v).toBe('Done');
    expect(cell(t.doc, 'A2')).toBeUndefined();
  });
  it('Ctrl+D and bold skip them', () => {
    const t = filtered();
    t.click('B2'); t.click('B4', { shiftKey: true });
    fireEvent.keyDown(t.grid, { key: 'd', code: 'KeyD', ctrlKey: true });
    fireEvent.keyDown(t.grid, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(cell(t.doc, 'B3').v).toBe(2);
    expect(cell(t.doc, 'B3').s).toBeUndefined();
    expect(cell(t.doc, 'B4')).toEqual({ v: 1, s: { b: true } });
  });
});

describe('moving cells', () => {
  it('sort re-aims formulas and carries notes', () => {
    const t = mount({ A1: '3', A2: '1', B1: '=A1*10', B2: '=A2*10' });
    const tb = buildCtx(t.doc).tabs[0];
    act(() => { setExtra(t.doc, 'notes', t.tab, `${tb.rows[0]}.${tb.cols[0]}`, { text: 'three', by: 'Pat' }); });
    t.click('A1'); t.click('B2', { shiftKey: true });
    fireEvent.click(screen.getByTitle('Sort A to Z'));
    const eng = createEngine(buildCtx(t.doc));
    expect(value(eng, t.tab, 'A1')).toBe(1);
    expect(value(eng, t.tab, 'B1')).toBe(10);
    expect(value(eng, t.tab, 'B2')).toBe(30);
    const notes = buildCtx(t.doc).tabs[0].notes;
    expect(notes.get(`${tb.rows[1]}.${tb.cols[0]}`)?.text).toBe('three');
    expect(notes.has(`${tb.rows[0]}.${tb.cols[0]}`)).toBe(false);
  });
  it('Split Text asks before it overwrites cells to the right', async () => {
    const t = mount({ A1: 'a,b', B1: 'keep' });
    t.click('A1');
    fireEvent.click(screen.getByTitle('Data'));
    fireEvent.click(screen.getByText('Split Text to Columns'));
    dialog.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Split' })); await Promise.resolve(); await Promise.resolve(); });
    expect(dialog.confirm).toHaveBeenCalled();
    expect(cell(t.doc, 'B1').v).toBe('keep');
  });
});

describe('export and inserted text', () => {
  it('CSV text that starts like a formula is written as text', async () => {
    const { doc } = book({ A1: "'=HYPERLINK(\"http://x\")", A2: '-5', A3: "'@sum", B1: 'plain' });
    let blob = null;
    const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    try { await exportSheetFile(doc, 'T', 'csv'); } finally { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; }
    const text = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(fr.result); fr.readAsText(blob); });
    expect(text.split('\r\n')).toEqual([`"'=HYPERLINK(""http://x"")",plain`, '-5,', "'@sum,"]);
  });
  it('a variable token with a quote is escaped in VAR()', () => {
    const t = mount({}, { variables: [{ token: 'odd"name', label: 'Odd', group: 'Other' }], variableValues: {} });
    fireEvent.click(screen.getByLabelText('Insert a Variable'));
    fireEvent.click(screen.getByText('Odd'));
    expect(cell(t.doc, 'A1').f).toBe('=VAR("odd""name")');
  });
  it("a colleague's color reaches a style only as hex", () => {
    const { doc } = book();
    const tb = buildCtx(doc).tabs[0];
    const states = new Map([[2, { user: { name: 'Sam', color: 'red;background:url(x)' }, sel: { tab: tb.id, r: tb.rows[0], c: tb.cols[0], r2: tb.rows[0], c2: tb.cols[0] } }]]);
    render(<SheetEditor doc={doc} canEdit title="T" awareness={{ clientID: 1, getStates: () => states, on: vi.fn(), off: vi.fn(), setLocalStateField: vi.fn() }} />);
    expect(screen.getByText('Sam').style.background).not.toContain('url');
  });
});
