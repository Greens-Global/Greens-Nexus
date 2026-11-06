import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import * as Y from 'yjs';

vi.mock('../ui/dialog', () => ({
  dialog: { confirm: vi.fn(() => Promise.resolve(true)), prompt: vi.fn(() => Promise.resolve('')), alert: vi.fn(() => Promise.resolve()) },
}));

import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc, exportSheetFile } from './index.js';
import {
  buildCtx, writeCells, newTabSnapshot, setExtra, extraOf, cellsOf, rangeIds, safeLink, deleteTab, addTab,
} from './model.js';
import { createEngine } from './formula/eval.js';
import { parseInput, formatValue } from './format.js';
import { computePivot, newPivot } from './pivot.js';

let realCreate, realRevoke;
beforeAll(() => {
  realCreate = URL.createObjectURL; realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
});
afterAll(() => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });

const BAD_CELLS = [null, [], { v: {} }, { s: { d: 1e9 } }, { v: 5, s: { nf: 'number', d: 500 } }, { v: 3, s: { d: -5 } }, { l: 'javascript:x' }, 'text', 7, { v: 'ok', l: 'https://x.com/' + 'a'.repeat(2100) }];

/** A tab with data, a filter over it, and every kind of bad cell written by "another browser". */
function poisoned() {
  const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('Data', 30, 6)] };
  const doc = seedSheetDoc(snap);
  const id = snap.tabs[0].id;
  const t = buildCtx(doc).tabs[0];
  writeCells(doc, id, [['Region', 'Amount'], ['East', '10'], ['West', '5'], ['East', '7']].flatMap((row, r) => row.map((v, c) => { const p = parseInput(v); return { r, c, v: p.v }; })));
  setExtra(doc, 'filter', id, 'f', { r: t.rows[0], c1: t.cols[0], c2: t.cols[1], crit: { [t.cols[0]]: { hide: ['West'] } } });
  BAD_CELLS.forEach((bad, i) => cellsOf(doc, id).set(`${t.rows[4 + i]}.${t.cols[i % 3]}`, bad));
  return { doc, id, t };
}

describe('a bad cell from another browser crashes nothing', () => {
  it('render, Find, export (xlsx and csv) and merge all survive', async () => {
    const { doc, id, t } = poisoned();
    expect(() => validateSheetDoc(doc)).not.toThrow();
    const view = render(<SheetEditor doc={doc} canEdit title="T" />);
    const grid = screen.getByRole('grid');
    act(() => { grid.focus(); });
    fireEvent.keyDown(grid, { key: 'f', code: 'KeyF', ctrlKey: true });
    fireEvent.change(screen.getByLabelText('Find in this tab'), { target: { value: 'e' } });
    expect(screen.getByLabelText('Find in this tab')).toBeTruthy();
    await exportSheetFile(doc, 'T', 'csv', id);
    await exportSheetFile(doc, 'T', 'xlsx', id);
    // Merge a block that holds bad cells.
    fireEvent.mouseDown(view.container.querySelector('[data-r="4"][data-c="0"]'), { button: 0 });
    fireEvent.mouseDown(view.container.querySelector('[data-r="8"][data-c="2"]'), { button: 0, shiftKey: true });
    fireEvent.mouseUp(window);
    fireEvent.click(screen.getByTitle('Merge Cells'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const snap = snapshotOf(doc);
    expect(() => validateSheetDoc(seedSheetDoc(snap))).not.toThrow();
    for (const cell of Object.values(snap.tabs[0].cells)) {
      expect(cell && typeof cell === 'object' && !Array.isArray(cell)).toBe(true);
      if (cell.l) expect(cell.l.startsWith('https://') && cell.l.length <= 2000).toBe(true);
    }
    void t;
  });
  it('formatValue clamps decimals instead of throwing', () => {
    expect(formatValue(1.5, { nf: 'number', d: 500 })).toBe('1.500000000000000');
    expect(formatValue(1.5, { nf: 'currency', d: -5 })).toBe('$2');
    expect(formatValue(1.5, { d: 1e9 })).toBe('1.500000000000000');
    expect(formatValue({}, null)).toBe('');
  });
  it('safeLink drops an address longer than 2,000 characters once encoded', () => {
    expect(safeLink('https://x.com/a' + ' '.repeat(700) + 'b')).toBe('');      // 700 spaces become 2,100 characters
    expect(safeLink('https://x.com/ok')).toBe('https://x.com/ok');
  });
  it('a seeded sample of junk renders and exports', async () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const junk = () => pick([null, true, 0, -3, 1e308, NaN, '', 'x', 'a'.repeat(600), [], [1], {}, { v: 1 }, { v: [] }, { s: { d: 999 } }, { f: '=1+' }, { l: 'mailto:' }, { v: 'x', s: { bg: 'url(x)', rot: 3 } }]);
    for (let k = 0; k < 12; k += 1) {
      const { doc, id, t } = poisoned();
      for (let n = 0; n < 8; n += 1) {
        const kind = pick(['cell', 'extra', 'meta']);
        if (kind === 'cell') cellsOf(doc, id).set(`${t.rows[Math.floor(rnd() * 20)]}.${t.cols[Math.floor(rnd() * 4)]}`, junk());
        else if (kind === 'extra') extraOf(doc, pick(['merges', 'notes', 'cf', 'dv', 'filter', 'pivots', 'groups', 'charts']), id).set(pick(['f', 'x', `${t.rows[1]}.${t.cols[0]}`]), junk());
        else doc.getMap('tabmeta').set(id, pick([junk(), { name: 'Data', frozenRows: 2 }]));
      }
      expect(() => validateSheetDoc(doc)).not.toThrow();
      render(<SheetEditor doc={doc} canEdit title="T" />);
      await exportSheetFile(doc, 'T', 'csv', id);
      cleanup();
    }
  });
});

describe('pivot cache never goes stale', () => {
  const setup = (dataA, dataB) => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('A', 20, 6), newTabSnapshot('B', 20, 6), newTabSnapshot('C', 20, 6)] };
    const doc = seedSheetDoc(snap);
    const [A, B, C] = snap.tabs.map((x) => x.id);
    const put = (tab, rows) => { const l = []; rows.forEach((row, r) => row.forEach((v, c) => { if (v == null) return; const p = parseInput(v); l.push({ r, c, v: p.v, f: p.f }); })); writeCells(doc, tab, l); };
    put(A, dataA); put(B, dataB);
    return { doc, A, B, C, put };
  };
  const pivotOn = (doc, A, C, r2) => {
    const ctx = buildCtx(doc); const ta = ctx.tabById(A), tc = ctx.tabById(C);
    const cfg = newPivot(rangeIds(ta, { r1: 0, c1: 0, r2, c2: 1 }), A, { r: tc.rows[0], c: tc.cols[0] });
    cfg.rows = [{ col: ta.cols[0], sort: 'asc' }]; cfg.values = [{ col: ta.cols[1], fn: 'SUM', show: '' }];
    setExtra(doc, 'pivots', C, 'p', cfg);
  };
  const run = (doc, C) => { const ctx = buildCtx(doc); const o = computePivot(createEngine(ctx), ctx, ctx.tabById(C).pivots.get('p')); return o.error || o.cells.map((r) => r.map((x) => (x ? x.v : null))); };
  it('a source spilled from another tab', () => {
    const { doc, A, B, C, put } = setup([['=B!A1:B3']], [['Region', 'Amt'], ['East', '10'], ['West', '5']]);
    pivotOn(doc, A, C, 2);
    expect(run(doc, C)[1]).toEqual(['East', 10]);
    put(B, [[null], ['East', '999']]);
    expect(run(doc, C)[1]).toEqual(['East', 999]);
  });
  it('a header that is a formula reading another tab', () => {
    const { doc, A, B, C, put } = setup([['=B!A1', 'Amt'], ['East', '1'], ['West', '2']], [['Region']]);
    pivotOn(doc, A, C, 2);
    expect(run(doc, C)[0][0]).toBe('Region');
    put(B, [['Zone']]);
    expect(run(doc, C)[0][0]).toBe('Zone');
  });
  it('a source that is another pivot', () => {
    const { doc, A, B, C, put } = setup([], [['Region', 'Amt'], ['East', '10'], ['West', '5']]);
    const ctx = buildCtx(doc); const ta = ctx.tabById(A), tb = ctx.tabById(B);
    const inner = newPivot(rangeIds(tb, { r1: 0, c1: 0, r2: 2, c2: 1 }), B, { r: ta.rows[0], c: ta.cols[0] });
    inner.rows = [{ col: tb.cols[0], sort: 'asc' }]; inner.values = [{ col: tb.cols[1], fn: 'SUM', show: '' }];
    setExtra(doc, 'pivots', A, 'in', inner);
    pivotOn(doc, A, C, 3);
    expect(run(doc, C)[1]).toEqual(['East', 10]);
    put(B, [[null], ['East', '999']]);
    expect(run(doc, C)[1]).toEqual(['East', 999]);
  });
  it('a plain source is kept until it changes', () => {
    const { doc, A, C, put } = setup([['R', 'Amt'], ['East', '1'], ['West', '2']], []);
    pivotOn(doc, A, C, 2);
    const ctx = buildCtx(doc); const cfg = ctx.tabById(C).pivots.get('p');
    const first = computePivot(createEngine(ctx), ctx, cfg);
    const ctx2 = buildCtx(doc);
    expect(computePivot(createEngine(ctx2), ctx2, ctx2.tabById(C).pivots.get('p'))).toBe(first);
    put(A, [[null], ['East', '50']]);
    expect(run(doc, C)[1]).toEqual(['East', 50]);
  });
});

describe('no tab left', () => {
  it('shows Add Sheet instead of crashing, and never saves an empty workbook', () => {
    const snap = { type: 'nexus-sheet', v: 1, tabs: [newTabSnapshot('A', 10, 4), newTabSnapshot('B', 10, 4)] };
    const doc = seedSheetDoc(snap);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    render(<SheetEditor doc={doc} canEdit title="T" />);
    // Two people each delete "the other" last tab at once.
    deleteTab(doc, snap.tabs[0].id);
    deleteTab(other, snap.tabs[1].id);
    act(() => { Y.applyUpdate(doc, Y.encodeStateAsUpdate(other)); });
    expect(buildCtx(doc).tabs).toHaveLength(0);
    expect(screen.getByText('This sheet has no tabs left.')).toBeTruthy();
    expect(snapshotOf(doc).tabs).toHaveLength(1);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Add Sheet' })); });
    expect(screen.getByRole('grid')).toBeTruthy();
    void addTab;
  });
});
