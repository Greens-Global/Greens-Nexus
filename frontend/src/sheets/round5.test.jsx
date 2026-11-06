import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';

vi.mock('../ui/dialog', () => ({
  dialog: { confirm: vi.fn(() => Promise.resolve(true)), prompt: vi.fn(() => Promise.resolve('')), alert: vi.fn(() => Promise.resolve()) },
}));

import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc } from './index.js';
import {
  buildCtx, writeCells, newTabSnapshot, setExtra, extraOf, cellsOf, rangeIds, deleteLines, namesOf, newId,
} from './model.js';
import { createEngine, isErr } from './formula/eval.js';
import { colIndex } from './formula/parse.js';
import { parseInput } from './format.js';
import { computePivot, newPivot } from './pivot.js';
import { groupsOf, hiddenRows } from './features.js';

const pos = (ref) => ({ r: Number(ref.match(/\d+/)[0]) - 1, c: colIndex(ref.match(/[A-Z]+/)[0]) });
function twoTabs(rows = [], size = 40) {
  const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Data', size, 8), newTabSnapshot('Out', size, 8)] };
  const doc = seedSheetDoc(snap);
  const [data, out] = snap.tabs.map((t) => t.id);
  const list = [];
  rows.forEach((row, r) => row.forEach((val, c) => { const p = parseInput(val); list.push({ r, c, v: p.v, f: p.f }); }));
  writeCells(doc, data, list);
  return { doc, data, out };
}
const DATA = [['Region', 'Amount', 'Rep'], ['East', '100', 'Ann'], ['West', '50', 'Bo'], ['East', '30', 'Bo']];
function pivot(doc, data, out, opts, at = 'A1') {
  const ctx = buildCtx(doc);
  const dt = ctx.tabById(data), ot = ctx.tabById(out);
  const col = (l) => dt.cols[colIndex(l)];
  const cfg = newPivot(rangeIds(dt, { r1: 0, c1: 0, r2: opts.r2 ?? DATA.length - 1, c2: 2 }), data, { r: ot.rows[pos(at).r], c: ot.cols[pos(at).c] });
  cfg.rows = (opts.rows || []).map((x) => ({ sort: 'asc', ...x, col: col(x.col) }));
  cfg.cols = (opts.cols || []).map((x) => ({ sort: 'asc', ...x, col: col(x.col) }));
  cfg.values = (opts.values || []).map((x) => ({ show: '', ...x, col: x.col === 'Z' ? newId() : col(x.col) }));
  cfg.filters = (opts.filters || []).map((x) => ({ ...x, col: col(x.col) }));
  if (opts.totals === false) cfg.totals = false;
  setExtra(doc, 'pivots', out, opts.id || 'p1', cfg);
  return cfg;
}
const grid = (doc, cfg) => { const ctx = buildCtx(doc); const o = computePivot(createEngine(ctx), ctx, cfg); return o.error || o.cells.map((r) => r.map((x) => (x ? x.v : null))); };
const at = (doc, tab, ref) => { const { r, c } = pos(ref); const v = createEngine(buildCtx(doc)).value(tab, r, c); return isErr(v) ? v.code : v; };

describe('one bad item never refuses the sheet', () => {
  it('drops a malformed entry of every kind and keeps the rest', () => {
    const { doc, data, out } = twoTabs(DATA);
    const t = buildCtx(doc).tabs[0];
    const g = rangeIds(t, { r1: 0, c1: 0, r2: 1, c2: 1 });
    const good = {
      merges: [`${t.rows[5]}.${t.cols[0]}`, { r2: t.rows[6], c2: t.cols[1] }],
      hidden: [t.rows[9], true],
      notes: [`${t.rows[0]}.${t.cols[0]}`, { text: 'ok' }],
      charts: ['ch', { type: 'pie', range: g, x: 0, y: 0, w: 300, h: 200 }],
      cf: ['cf', { range: g, type: 'empty', style: { b: true } }],
      dv: ['dv', { range: g, kind: 'checkbox' }],
      groups: ['gr', { axis: 'rows', a: t.rows[2], b: t.rows[3] }],
    };
    const bad = {
      merges: [`${t.rows[7]}.${t.cols[0]}`, { r2: 5 }],
      hidden: [t.rows[10], 'yes'],
      notes: [`${t.rows[1]}.${t.cols[0]}`, { text: 7 }],
      charts: ['ch2', { type: 'radar', range: g, x: 0, y: 0, w: 300, h: 200 }],
      cf: ['cf2', { range: g, type: 'eval', style: {} }],
      dv: ['dv2', { range: 'A1', kind: 'list' }],
      groups: ['gr2', { axis: 'diagonal', a: t.rows[2], b: t.rows[3] }],
    };
    for (const [kind, [k, v]] of Object.entries(good)) setExtra(doc, kind, data, k, v);
    for (const [kind, [k, v]] of Object.entries(bad)) extraOf(doc, kind, data).set(k, v);
    setExtra(doc, 'filter', data, 'f', { r: t.rows[0], c1: t.cols[0], c2: t.cols[2], crit: {} });
    extraOf(doc, 'filter', data).set('other', { r: 1 });
    const cfg = pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }], filters: [{ col: 'A', hide: ['x'.repeat(600)] }] });
    extraOf(doc, 'pivots', out).set('bad', { ...cfg, values: [{ col: cfg.values[0].col, fn: 'DROP TABLE' }] });
    namesOf(doc).set('ok', { name: 'Ok', tab: data, range: g });
    namesOf(doc).set('b2', { name: 'B2', tab: data, range: g });
    cellsOf(doc, data).set(`${t.rows[20]}.${t.cols[0]}`, { v: 'styled', s: { b: true, glow: 'neon', fs: 400 } });

    expect(() => validateSheetDoc(doc)).not.toThrow();
    const snap = snapshotOf(doc);
    const [ds, os] = snap.tabs;
    for (const [kind, [k]] of Object.entries(good)) expect(ds[kind][k]).toBeTruthy();
    for (const [kind, [k]] of Object.entries(bad)) expect(ds[kind]?.[k]).toBeUndefined();
    expect(ds.filter.f).toBeTruthy();
    expect(ds.filter.other).toBeUndefined();
    expect(os.pivots.p1.filters[0].hide[0]).toHaveLength(500);     // cut, not dropped
    expect(os.pivots.bad).toBeUndefined();
    expect(snap.names.ok).toBeTruthy();
    expect(snap.names.b2).toBeUndefined();
    expect(ds.cells[`${t.rows[20]}.${t.cols[0]}`]).toEqual({ v: 'styled', s: { b: true } });
    expect(() => validateSheetDoc(seedSheetDoc(snap))).not.toThrow();
  });
});

describe('pivots, round five', () => {
  it('a 600-character label filters at its stored length (pivot and sheet filter)', () => {
    const long = 'Q'.repeat(600);
    const { doc, data, out } = twoTabs([['Name', 'Amount', 'Rep'], [long, '5', 'a'], ['Short', '7', 'b']]);
    const cfg = pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }], filters: [{ col: 'A', hide: [long] }], r2: 2 });
    expect(grid(doc, cfg)).toEqual([['Name', 'SUM of Amount'], ['Short', 7], ['Grand Total', 7]]);
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'filter', data, 'f', { r: t.rows[0], c1: t.cols[0], c2: t.cols[1], crit: { [t.cols[0]]: { hide: [long.slice(0, 500)] } } });
    const ctx = buildCtx(doc);
    expect([...hiddenRows(ctx, createEngine(ctx), ctx.tabs[0])]).toEqual([1]);
  });
  it('keeps its result until its source changes', () => {
    const { doc, data, out } = twoTabs(DATA);
    const cfg = pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }] });
    const run = () => { const ctx = buildCtx(doc); return computePivot(createEngine(ctx), ctx, ctx.tabById(out).pivots.get('p1')); };
    const first = run();
    writeCells(doc, out, [{ ...pos('H20'), v: 'elsewhere' }]);
    expect(run()).toBe(first);
    writeCells(doc, data, [{ ...pos('B2'), v: 200 }]);
    const again = run();
    expect(again).not.toBe(first);
    expect(again.cells[1][1].v).toBe(230);
    void cfg;
  });
  it('with no Rows fields draws the summary line once (with and without Columns)', () => {
    const { doc, data, out } = twoTabs(DATA);
    const cfg = pivot(doc, data, out, { values: [{ col: 'B', fn: 'SUM' }] });
    expect(grid(doc, cfg)).toEqual([['SUM of Amount'], [180]]);
    cfg.cols = [{ col: buildCtx(doc).tabById(data).cols[2], sort: 'asc' }];
    expect(grid(doc, cfg)).toEqual([['Ann', 'Bo', 'Grand Total'], ['SUM of Amount', 'SUM of Amount', 'SUM of Amount'], [100, 80, 180]]);
  });
  it('`by` finds its value through the settings index; dates group only real dates', () => {
    const { doc, data, out } = twoTabs([['Region', 'Amount', 'When'], ['East', '10', '11/05/2026'], ['West', '90', '-4'], ['North', '50', '']]);
    const cfg = pivot(doc, data, out, { rows: [{ col: 'A', by: 1, sort: 'desc' }], values: [{ col: 'Z', fn: 'COUNT' }, { col: 'B', fn: 'SUM' }], totals: false, r2: 3 });
    expect(grid(doc, cfg).slice(1).map((r) => r[0])).toEqual(['West', 'North', 'East']);
    const byDate = pivot(doc, data, out, { rows: [{ col: 'C', group: 'month' }], values: [{ col: 'B', fn: 'SUM' }], totals: false, r2: 3 });
    expect(grid(doc, byDate).slice(1).map((r) => r[0])).toEqual(['-4', '11/2026', '(Blank)']);   // -4 is not a date: shown as itself
  });
  it('rows deleted under a pivot and its source move it to the nearest survivor', () => {
    const { doc, data, out } = twoTabs(DATA);
    pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }] }, 'A3');
    deleteLines(doc, out, 'rows', 2, 1);             // the pivot's corner row
    expect(at(doc, out, 'B3')).toBe('SUM of Amount');   // now drawn from row 3, the row that took its place
    expect(at(doc, out, 'B4')).toBe(130);
    deleteLines(doc, data, 'rows', 0, 1);            // the source's header row: the next row becomes the header
    const cfg = buildCtx(doc).tabById(out).pivots.get('p1');
    expect(buildCtx(doc).rowIndex(buildCtx(doc).tabById(data), cfg.src.r1)).toBe(0);
    deleteLines(doc, data, 'rows', 0, 3);            // everything: the pivot goes
    expect(buildCtx(doc).tabById(out).pivots.size).toBe(0);
  });
  it("typing over a pivot's corner is refused and its error is shown", () => {
    const { doc, data, out } = twoTabs(DATA);
    pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }] });
    writeCells(doc, out, [{ ...pos('A1'), v: 'pasted' }]);
    const toastErr = vi.fn();
    render(<SheetEditor doc={doc} canEdit title="T" toastErr={toastErr} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Out' }));
    expect(screen.getByText(/Pivot Table: This pivot would overwrite cells/)).toBeTruthy();
    writeCells(doc, out, [{ ...pos('A1'), v: null }]);
    const grid2 = screen.getByRole('grid');
    act(() => { grid2.focus(); });
    fireEvent.keyDown(grid2, { key: 'x' });
    expect(toastErr).toHaveBeenCalledWith(expect.stringMatching(/part of a pivot table/));
  });
  it('a spill and a pivot never overlap silently', () => {
    const { doc, data, out } = twoTabs(DATA);
    pivot(doc, data, out, { rows: [{ col: 'A' }], values: [{ col: 'B', fn: 'SUM' }] }, 'B1');
    writeCells(doc, out, [{ ...pos('A2'), f: '=SEQUENCE(1,3)' }]);     // spills into B2:C2 - the pivot's cells
    const eng = createEngine(buildCtx(doc));
    const piv = eng.value(out, 0, 1), sp = eng.value(out, 1, 0);
    const errs = [piv, sp].filter((v) => isErr(v)).map((v) => v.code);
    expect(errs.length).toBe(1);
    expect(['#REF!', '#SPILL!']).toContain(errs[0]);
  });
});

describe('groups and data entry, round five', () => {
  it('groups from live data stay three levels deep and never cross', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('S', 500, 4)] };
    const doc = seedSheetDoc(snap);
    const t = buildCtx(doc).tabs[0];
    extraOf(doc, 'groups', t.id).set('cross', { axis: 'rows', a: t.rows[1], b: t.rows[499] });
    for (let i = 0; i < 199; i += 1) extraOf(doc, 'groups', t.id).set(`g${String(i).padStart(3, '0')}`, { axis: 'rows', a: t.rows[i], b: t.rows[499 - i] });
    extraOf(doc, 'groups', t.id).set('zcross', { axis: 'rows', a: t.rows[0], b: t.rows[250] });    // past the 200 cap: never read
    const ctx = buildCtx(doc);
    const list = groupsOf(ctx, ctx.tabs[0], 'rows');
    expect(Math.max(...list.map((g) => g.level))).toBe(3);
    expect(list.map((g) => g.id)).toEqual(['g000', 'cross', 'g001']);
    const view = render(<SheetEditor doc={doc} canEdit title="T" />);
    expect(view.container.querySelectorAll('[data-group]').length).toBeLessThanOrEqual(3);
  });
  it('Ungroup takes away only the innermost group', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('S', 40, 4)] };
    const doc = seedSheetDoc(snap);
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'groups', t.id, 'outer', { axis: 'rows', a: t.rows[1], b: t.rows[9] });
    setExtra(doc, 'groups', t.id, 'inner', { axis: 'rows', a: t.rows[2], b: t.rows[4] });
    const view = render(<SheetEditor doc={doc} canEdit title="T" />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    fireEvent.mouseDown(view.container.querySelector('[data-r="3"][data-c="0"]'), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.keyDown(grid, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true });
    expect([...buildCtx(doc).tabs[0].groups.keys()]).toEqual(['outer']);
  });
  it('a group starting in frozen rows still has its button', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [{ ...newTabSnapshot('S', 40, 4), frozenRows: 3 }] };
    const doc = seedSheetDoc(snap);
    const t = buildCtx(doc).tabs[0];
    setExtra(doc, 'groups', t.id, 'g', { axis: 'rows', a: t.rows[0], b: t.rows[0] });
    render(<SheetEditor doc={doc} canEdit title="T" />);
    expect(screen.getByLabelText('Collapse rows 1 to 1')).toBeTruthy();
  });
  it('Enter after a run of Tabs goes to the column where the run started', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('S', 40, 8)] };
    const doc = seedSheetDoc(snap);
    render(<SheetEditor doc={doc} canEdit title="T" />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    const type = (text, key) => {
      fireEvent.keyDown(grid, { key: text[0] });
      const ed = document.querySelector('textarea.nxs-cell-input');
      fireEvent.change(ed, { target: { value: text } });
      fireEvent.keyDown(ed, { key });
    };
    type('Region', 'Tab'); type('Rep', 'Tab'); type('Amount', 'Enter'); type('East', 'Tab');
    const ctx = buildCtx(doc), tab = ctx.tabs[0];
    expect(ctx.cell(tab, 1, 0)?.v).toBe('East');
    expect(screen.getByLabelText('Name Box').value).toBe('B2');
    // An arrow resets the run: Enter then goes straight down.
    fireEvent.keyDown(grid, { key: 'ArrowRight', code: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(screen.getByLabelText('Name Box').value).toBe('C3');
    // Tab and Enter on a selected cell (no editing) follow the same rule.
    fireEvent.keyDown(grid, { key: 'Tab' });
    fireEvent.keyDown(grid, { key: 'Tab' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(screen.getByLabelText('Name Box').value).toBe('C4');
    void Y;
  });
});
