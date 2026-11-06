import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';

vi.mock('../ui/dialog', () => ({
  dialog: { confirm: vi.fn(() => Promise.resolve(true)), prompt: vi.fn(() => Promise.resolve('')), alert: vi.fn(() => Promise.resolve()) },
}));

import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc } from './index.js';
import {
  buildCtx, writeCells, newTabSnapshot, setExtra, extraOf, rangeIds, insertLines, validStyle, LIMITS, addTab,
} from './model.js';
import { createEngine, isErr } from './formula/eval.js';
import { colIndex } from './formula/parse.js';
import { parseInput, serialFromYMD } from './format.js';
import { computePivot, newPivot, summarize, pivotValues } from './pivot.js';
import { groupsOf, groupProblem, hiddenRows } from './features.js';

const pos = (ref) => ({ r: Number(ref.match(/\d+/)[0]) - 1, c: colIndex(ref.match(/[A-Z]+/)[0]) });
const DATA = [
  ['Region', 'Date', 'Amount', 'Rep'],
  ['East', '01/15/2026', '100', 'Ann'],
  ['West', '01/20/2026', '50', 'Bo'],
  ['East', '02/03/2026', '30', 'Bo'],
  ['North', '03/30/2026', '20', 'Ann'],
  ['West', '04/02/2026', '150', 'Ann'],
];
function source() {
  const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Data', 50, 10), newTabSnapshot('Pivot', 50, 10)] };
  const doc = seedSheetDoc(snap);
  const [data, piv] = snap.tabs.map((t) => t.id);
  const list = [];
  DATA.forEach((row, r) => row.forEach((val, c) => { const p = parseInput(val); list.push({ r, c, v: p.v, s: p.nf ? { nf: p.nf } : null }); }));
  writeCells(doc, data, list);
  return { doc, data, piv };
}
/** A pivot on the Pivot tab at A1 over Data!A1:D6, with these settings by column letter. */
function pivotOf(doc, data, piv, opts) {
  const ctx = buildCtx(doc);
  const dt = ctx.tabById(data), pt = ctx.tabById(piv);
  const col = (letter) => dt.cols[colIndex(letter)];
  const cfg = newPivot(rangeIds(dt, { r1: 0, c1: 0, r2: 5, c2: 3 }), data, { r: pt.rows[0], c: pt.cols[0] });
  cfg.rows = (opts.rows || []).map((x) => ({ sort: 'asc', ...x, col: col(x.col) }));
  cfg.cols = (opts.cols || []).map((x) => ({ sort: 'asc', ...x, col: col(x.col) }));
  cfg.values = (opts.values || []).map((x) => ({ show: '', ...x, col: col(x.col) }));
  cfg.filters = (opts.filters || []).map((x) => ({ ...x, col: col(x.col) }));
  if (opts.totals === false) cfg.totals = false;
  setExtra(doc, 'pivots', piv, 'p1', cfg);
  return cfg;
}
const grid = (doc, cfg) => {
  const ctx = buildCtx(doc);
  const out = computePivot(createEngine(ctx), ctx, cfg);
  return out.error || out.cells.map((row) => row.map((x) => (x ? x.v : null)));
};
const at = (doc, tab, ref) => { const { r, c } = pos(ref); const v = createEngine(buildCtx(doc)).value(tab, r, c); return isErr(v) ? v.code : v; };

describe('pivot tables', () => {
  it('sums by region with a grand total, Title Case headers', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'A' }], values: [{ col: 'C', fn: 'SUM' }] });
    expect(grid(doc, cfg)).toEqual([
      ['Region', 'SUM of Amount'], ['East', 130], ['North', 20], ['West', 200], ['Grand Total', 350],
    ]);
    // Drawn on the Pivot tab like a spill.
    expect(at(doc, piv, 'B2')).toBe(130);
    expect(at(doc, piv, 'A5')).toBe('Grand Total');
  });
  it('count, average, and % of grand total', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'A' }], values: [{ col: 'C', fn: 'COUNT' }, { col: 'C', fn: 'AVERAGE' }, { col: 'C', fn: 'SUM', show: 'total' }] });
    const g = grid(doc, cfg);
    expect(g[0]).toEqual(['Region', 'COUNT of Amount', 'AVERAGE of Amount', 'SUM of Amount']);
    expect(g[1]).toEqual(['East', 2, 65, 130 / 350]);
    expect(g[4]).toEqual(['Grand Total', 5, 70, 1]);
  });
  it('columns, % of row and % of column', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'A' }], cols: [{ col: 'D' }], values: [{ col: 'C', fn: 'SUM' }] });
    expect(grid(doc, cfg)).toEqual([
      ['Rep', 'Ann', 'Bo', 'Grand Total'],
      ['Region', 'SUM of Amount', 'SUM of Amount', 'SUM of Amount'],
      ['East', 100, 30, 130], ['North', 20, null, 20], ['West', 150, 50, 200], ['Grand Total', 270, 80, 350],
    ]);
    cfg.values[0].show = 'row';
    expect(grid(doc, cfg)[2]).toEqual(['East', 100 / 130, 30 / 130, 1]);
    cfg.values[0].show = 'col';
    expect(grid(doc, cfg)[2]).toEqual(['East', 100 / 270, 30 / 80, 130 / 350]);
  });
  it('groups dates by month, quarter and year (US labels)', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'B', group: 'month' }], values: [{ col: 'C', fn: 'SUM' }], totals: false });
    expect(grid(doc, cfg)).toEqual([['Date', 'SUM of Amount'], ['01/2026', 150], ['02/2026', 30], ['03/2026', 20], ['04/2026', 150]]);
    cfg.rows[0].group = 'quarter';
    expect(grid(doc, cfg).slice(1)).toEqual([['Q1 2026', 200], ['Q2 2026', 150]]);
    cfg.rows[0].group = 'year';
    expect(grid(doc, cfg).slice(1)).toEqual([['2026', 350]]);
    cfg.rows[0].group = 'day';
    expect(grid(doc, cfg)[1]).toEqual(['01/15/2026', 100]);
    expect(serialFromYMD(2026, 1, 15)).toBeGreaterThan(0);
  });
  it('filters, sorting by label and by value, totals off', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'A', sort: 'desc' }], values: [{ col: 'C', fn: 'SUM' }], filters: [{ col: 'D', hide: ['Bo'] }], totals: false });
    expect(grid(doc, cfg)).toEqual([['Region', 'SUM of Amount'], ['West', 150], ['North', 20], ['East', 100]]);
    cfg.rows[0] = { ...cfg.rows[0], by: 0, sort: 'desc' };
    expect(grid(doc, cfg).slice(1).map((r) => r[0])).toEqual(['West', 'East', 'North']);
    const ctx = buildCtx(doc);
    expect(pivotValues(createEngine(ctx), ctx, cfg, cfg.filters[0].col)).toEqual([{ text: 'Ann', count: 3 }, { text: 'Bo', count: 2 }]);
  });
  it('summarizes every way', () => {
    const v = [3, 1, 2, '', 'x', 2];
    expect(['SUM', 'COUNT', 'COUNTA', 'COUNTUNIQUE', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN', 'PRODUCT'].map((f) => summarize(f, v))).toEqual([8, 4, 5, 4, 2, 1, 3, 2, 12]);
    expect(summarize('VAR', [2, 4, 4, 5, 9])).toBeCloseTo(6.7);
    expect(summarize('STDEV', [2, 4, 4, 5, 9])).toBeCloseTo(2.5884, 3);
  });
  it('keeps pointing at its data through concurrent inserts in two copies', () => {
    const { doc, data, piv } = source();
    pivotOf(doc, data, piv, { rows: [{ col: 'A' }], values: [{ col: 'C', fn: 'SUM' }] });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    insertLines(doc, data, 'rows', 0, 2);                      // me: two rows above the header
    insertLines(other, data, 'rows', 3, 1);                    // them: a row inside the data...
    writeCells(other, data, [{ r: 3, c: 0, v: 'East' }, { r: 3, c: 2, v: 70 }]);   // ...with an East sale
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    for (const d of [doc, other]) {
      expect(at(d, piv, 'B2')).toBe(200);     // East 130 + 70
      expect(at(d, piv, 'B5')).toBe(420);
    }
  });
  it('reads #REF! when its cells are taken, and edits refuse inside it', () => {
    const { doc, data, piv } = source();
    pivotOf(doc, data, piv, { rows: [{ col: 'A' }], values: [{ col: 'C', fn: 'SUM' }] });
    writeCells(doc, piv, [{ ...pos('B3'), v: 'mine' }]);
    const ctx = buildCtx(doc);
    const v = createEngine(ctx).value(piv, 0, 0);
    expect(v.code).toBe('#REF!');
    expect(v.note).toMatch(/overwrite/);
    expect(at(doc, piv, 'B2')).toBe(null);
  });
  it('caps and validation', () => {
    const { doc, data, piv } = source();
    const cfg = pivotOf(doc, data, piv, { rows: [{ col: 'A' }], values: [{ col: 'C', fn: 'SUM' }] });
    for (let i = 0; i < LIMITS.pivots + 3; i += 1) extraOf(doc, 'pivots', piv).set(`x${i}`, cfg);
    expect(() => validateSheetDoc(doc)).not.toThrow();
    const snap = snapshotOf(doc);
    expect(Object.keys(snap.tabs[1].pivots)).toHaveLength(LIMITS.pivots);
    expect(() => validateSheetDoc(seedSheetDoc(snap))).not.toThrow();
    const bad = (fn) => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(doc)); fn(d); return () => validateSheetDoc(d); };
    expect(bad((d) => extraOf(d, 'pivots', piv).set('b', { ...cfg, values: [{ col: cfg.values[0].col, fn: 'EVAL' }] }))).toThrow();
    expect(bad((d) => extraOf(d, 'pivots', piv).set('b', { ...cfg, rows: Array(6).fill(cfg.rows[0]) }))).toThrow();
    expect(bad((d) => extraOf(d, 'pivots', piv).set('b', { ...cfg, src: { ...cfg.src, tab: 'bad id!' } }))).toThrow();
  });
  it('the editor opens from Insert and builds a pivot on a new tab', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Data', 50, 10)] };
    const doc = seedSheetDoc(snap);
    const list = [];
    DATA.forEach((row, r) => row.forEach((val, c) => { const p = parseInput(val); list.push({ r, c, v: p.v }); }));
    writeCells(doc, snap.tabs[0].id, list);
    render(<SheetEditor doc={doc} canEdit title="T" />);
    fireEvent.click(screen.getByTitle('Insert'));
    fireEvent.click(screen.getByText('Pivot Table'));
    expect(screen.getByLabelText('Data Range (with a header row)').value).toBe('A1:D6');
    fireEvent.click(screen.getByText('Create'));
    expect(buildCtx(doc).tabs.map((t) => t.name)).toEqual(['Data', 'Pivot Table']);
    expect(screen.getByRole('dialog', { name: 'Pivot Table Editor' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add to Rows'), { target: { value: buildCtx(doc).tabs[0].cols[0] } });
    fireEvent.change(screen.getByLabelText('Add to Values'), { target: { value: buildCtx(doc).tabs[0].cols[2] } });
    const pt = buildCtx(doc).tabs[1];
    expect(at(doc, pt.id, 'B2')).toBe(130);
    expect(screen.getAllByText('Grand Total').length).toBeGreaterThan(0);
  });
});

describe('groups', () => {
  const tabDoc = () => { const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('S', 40, 10)] }; return { doc: seedSheetDoc(snap), tab: snap.tabs[0].id }; };
  it('nest up to three levels and refuse crossing groups', () => {
    const { doc, tab } = tabDoc();
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'groups', tab, 'g1', { axis: 'rows', a: t.rows[1], b: t.rows[10] });
    setExtra(doc, 'groups', tab, 'g2', { axis: 'rows', a: t.rows[2], b: t.rows[5] });
    setExtra(doc, 'groups', tab, 'g3', { axis: 'rows', a: t.rows[3], b: t.rows[4] });
    const ctx = buildCtx(doc);
    const list = groupsOf(ctx, ctx.tabs[0], 'rows');
    expect(list.map((g) => [g.id, g.level])).toEqual([['g1', 1], ['g2', 2], ['g3', 3]]);
    expect(groupProblem(list, 3, 3)).toMatch(/3 levels/);
    expect(groupProblem(list, 4, 12)).toMatch(/across/);
    expect(groupProblem(list, 12, 14)).toBe('');
    expect(groupProblem(list, 0, 20)).toMatch(/3 levels/);
  });
  it('collapse hides for everyone; concurrent groups merge', () => {
    const { doc, tab } = tabDoc();
    const t = buildCtx(doc).tabs[0];
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    setExtra(doc, 'groups', tab, 'a', { axis: 'rows', a: t.rows[1], b: t.rows[8] });
    setExtra(other, 'groups', tab, 'b', { axis: 'rows', a: t.rows[2], b: t.rows[3], collapsed: true });
    insertLines(other, tab, 'rows', 3, 2);       // inside b: it grows to rows 3..6
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    const ctx = buildCtx(doc);
    const list = groupsOf(ctx, ctx.tabs[0], 'rows');
    expect(list.map((g) => [g.id, g.s, g.e, g.level])).toEqual([['a', 1, 10, 1], ['b', 2, 5, 2]]);
    expect([...hiddenRows(ctx, createEngine(ctx), ctx.tabs[0])].sort((x, y) => x - y)).toEqual([2, 3, 4, 5]);
  });
  it('Alt+Shift+Right groups, the gutter button collapses and expands, Alt+Shift+Left ungroups', () => {
    const { doc } = tabDoc();
    const view = render(<SheetEditor doc={doc} canEdit title="T" />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    fireEvent.mouseDown(view.container.querySelector('[data-r="1"][data-c="0"]'), { button: 0 });
    fireEvent.mouseDown(view.container.querySelector('[data-r="3"][data-c="0"]'), { button: 0, shiftKey: true });
    fireEvent.mouseUp(window);
    fireEvent.keyDown(grid, { key: 'ArrowRight', code: 'ArrowRight', altKey: true, shiftKey: true });
    expect(buildCtx(doc).tabs[0].groups.size).toBe(1);
    fireEvent.mouseDown(screen.getByLabelText('Collapse rows 2 to 4'));
    expect(view.container.querySelector('[data-row="2"]')).toBeNull();
    fireEvent.mouseDown(screen.getByLabelText('Expand rows 2 to 4'));
    expect(view.container.querySelector('[data-row="2"]')).toBeTruthy();
    fireEvent.keyDown(grid, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true });
    expect(buildCtx(doc).tabs[0].groups.size).toBe(0);
  });
});

describe('text rotation', () => {
  it('validates like any style and draws', () => {
    for (const rot of [45, -45, 90, -90, 'v']) expect(validStyle({ rot })).toBe(true);
    for (const rot of [30, '45', 'rotate(1turn)', null]) expect(validStyle({ rot })).toBe(false);
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('S', 10, 5)] };
    const doc = seedSheetDoc(snap);
    writeCells(doc, snap.tabs[0].id, [{ r: 0, c: 0, v: 'Tilted', s: { rot: 45 } }, { r: 1, c: 0, v: 'Stack', s: { rot: 'v' } }]);
    render(<SheetEditor doc={doc} canEdit title="T" />);
    expect(screen.getByText('Tilted', { selector: '.nxs-text' }).style.transform).toBe('rotate(-45deg)');
    expect(screen.getByText('Stack', { selector: '.nxs-text' }).style.writingMode).toBe('vertical-rl');
    void addTab;
  });
});
