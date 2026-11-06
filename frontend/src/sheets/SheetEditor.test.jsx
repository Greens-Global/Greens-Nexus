import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';
import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc, newSheetContent } from './index.js';
import { buildCtx, writeCells, cellsOf, rowsOf } from './model.js';
import { parseTSV, toTSV, parseHTMLTable } from './clipboard.js';

describe('snapshot', () => {
  it('round-trips seed -> snapshot', () => {
    const snap = newSheetContent();
    expect(snap.tabs[0].rows).toHaveLength(1000);
    expect(snap.tabs[0].cols).toHaveLength(26);
    const doc = seedSheetDoc(snap);
    const tab = snap.tabs[0].id;
    writeCells(doc, tab, [{ r: 0, c: 0, v: 5, s: { b: true } }, { r: 1, c: 0, f: '=A1*2' }]);
    const out = snapshotOf(doc);
    const again = snapshotOf(seedSheetDoc(out));
    expect(again).toEqual(out);
    expect(Object.values(out.tabs[0].cells)).toEqual(expect.arrayContaining([{ v: 5, s: { b: true } }]));
  });
  it('accepts a good state and refuses bad ones', () => {
    const doc = seedSheetDoc(newSheetContent());
    expect(() => validateSheetDoc(doc)).not.toThrow();
    const tab = snapshotOf(doc).tabs[0].id;
    const bad = (fn) => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(doc)); fn(d); return () => validateSheetDoc(d); };
    expect(bad((d) => cellsOf(d, tab).set('x.y', { v: 1, s: { bg: 'url(http://evil)' } }))).toThrow();
    expect(bad((d) => cellsOf(d, tab).set('x.y', { v: 1, onclick: 'x' }))).toThrow();
    expect(bad((d) => cellsOf(d, tab).set('x.y', { v: 'a'.repeat(50001) }))).toThrow();
    expect(bad((d) => cellsOf(d, tab).set('x.y', { f: 'SUM(1)' }))).toThrow();
    expect(bad((d) => rowsOf(d, tab).push([{ evil: 1 }]))).toThrow();
    expect(bad((d) => d.getArray('tabs').delete(0, 1))).toThrow();
    expect(() => validateSheetDoc(new Y.Doc())).toThrow();
  });
});

describe('clipboard', () => {
  it('reads Excel and Sheets text', () => {
    expect(parseTSV('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseTSV('"x\ty"\t"he said ""hi"""\r\n"two\nlines"\t')).toEqual([['x\ty', 'he said "hi"'], ['two\nlines', '']]);
    expect(parseTSV(toTSV([['a\tb', 'c"d'], ['', 'e']]))).toEqual([['a\tb', 'c"d'], ['', 'e']]);
    expect(parseHTMLTable('<table><tr><td>1</td><td> two </td></tr></table>')).toEqual([['1', 'two']]);
  });
});

describe('SheetEditor', () => {
  it('renders the grid and commits typing on Enter', () => {
    const doc = seedSheetDoc(newSheetContent());
    const onChange = vi.fn();
    render(<SheetEditor doc={doc} canEdit title="Budget" onChange={onChange} />);
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('aria-rowcount')).toBe('1000');
    act(() => { grid.focus(); });
    fireEvent.keyDown(grid, { key: '4' });
    const input = screen.getByLabelText('Edit A1');
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const ctx = buildCtx(doc);
    expect(ctx.cell(ctx.tabs[0], 0, 0)).toEqual({ v: 42 });
    expect(onChange).toHaveBeenCalled();
    // Now on A2: a formula through the formula bar.
    const bar = screen.getByLabelText('Formula Bar');
    fireEvent.focus(bar);
    fireEvent.change(bar, { target: { value: '=A1*2' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(screen.getAllByText('84').length).toBeGreaterThan(0);
  });
  it('ignores a malformed live edit instead of crashing', () => {
    const doc = seedSheetDoc(newSheetContent());
    const t = buildCtx(doc).tabs[0];
    render(<SheetEditor doc={doc} canEdit title="Budget" />);
    act(() => {
      cellsOf(doc, t.id).set(`${t.rows[0]}.${t.cols[0]}`, { v: { evil: 1 }, s: { bg: 'url(x)' } });
      doc.getMap('tabmeta').set(t.id, { name: { not: 'text' } });
    });
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getByText('Sheet')).toBeTruthy();
  });
  it('is read-only without edit rights', () => {
    const doc = seedSheetDoc(newSheetContent());
    render(<SheetEditor doc={doc} canEdit={false} title="Budget" />);
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'x' });
    expect(screen.queryByLabelText('Edit A1')).toBeNull();
    expect(screen.getByText('View Only')).toBeTruthy();
  });
  it('draws someone else’s selection with their name', () => {
    const doc = seedSheetDoc(newSheetContent());
    const ctx = buildCtx(doc);
    const t = ctx.tabs[0];
    const states = new Map([[2, { user: { name: 'Pat Lee', color: '#16a34a' }, sel: { tab: t.id, r: t.rows[0], c: t.cols[0], r2: t.rows[0], c2: t.cols[0] } }], [3, { sel: 'junk' }]]);
    const awareness = { clientID: 1, getStates: () => states, on: vi.fn(), off: vi.fn(), setLocalStateField: vi.fn() };
    render(<SheetEditor doc={doc} awareness={awareness} canEdit title="Budget" />);
    expect(screen.getByText('Pat Lee')).toBeTruthy();
  });
});
