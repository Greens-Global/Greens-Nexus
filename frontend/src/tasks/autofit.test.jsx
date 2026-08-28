import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api', () => ({
  api: {
    getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })),
    saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
    resetTaskTablePrefs: vi.fn(() => Promise.resolve({})),
    resetAllTaskTablePrefs: vi.fn(() => Promise.resolve({})),
  },
}));

import { api } from '../api';
import { useTableColumns, TableHead, __setTablePrefsCache } from './tableCols';

// Double-clicking a column's right edge fits it to its content, the gesture
// people bring from Excel. It replaced "reset to the default width" on that
// handle - the Reset Columns button in every toolbar already covers resetting,
// and it covers all the columns at once.
//
// jsdom has no layout engine: getBoundingClientRect is 0 everywhere, so the
// widths a real browser would measure are stubbed per cell here. What these
// pin is the wiring and the arithmetic around the measurement - which column
// is measured, that the header counts, the clamps, and that the max-content
// probe is never left behind in the template.

const COLS = [
  { key: 'name', label: 'Name', template: 'minmax(0,2fr)' },
  { key: 'owner', label: 'Owner', width: 150 },
  { key: 'due', label: 'Due', width: 118 },
];

// width the stub reports for a cell, keyed "<rowIndex>:<colIndex>"
let cellWidths = {};

function Harness({ cols = COLS }) {
  const { cols: ordered, template, widths, startResize, resetWidth, autofitWidth, wrapRef } =
    useTableColumns({ table: 't', cols });
  return (
    <div ref={wrapRef} style={{ '--nx-grid': template }} data-testid="wrap">
      <div style={{ gridTemplateColumns: 'var(--nx-grid)' }} data-testid="header">
        {ordered.map((c) => (
          <TableHead key={c.key} label={c.label}
            onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 150)}
            onResizeReset={() => resetWidth(c.key)}
            onResizeAutofit={() => autofitWidth(c.key)} />
        ))}
      </div>
      <div style={{ gridTemplateColumns: 'var(--nx-grid)' }} data-testid="row0">
        {ordered.map((c) => <div key={c.key}>{c.key}</div>)}
      </div>
      <div style={{ gridTemplateColumns: 'var(--nx-grid)' }} data-testid="row1">
        {ordered.map((c) => <div key={c.key}>{c.key}</div>)}
      </div>
    </div>
  );
}

// Each grid's children report the widths the test sets up, so autofitWidth has
// something to take a maximum of.
const stubWidths = () => {
  const grids = ['header', 'row0', 'row1'];
  grids.forEach((id, ri) => {
    const el = screen.getByTestId(id);
    Array.from(el.children).forEach((cell, ci) => {
      cell.getBoundingClientRect = () => ({ width: cellWidths[`${ri}:${ci}`] ?? 0, height: 20 });
    });
  });
};

// The resize handles are in column order, one per header cell.
const EDGE_TITLE = 'Drag to resize, double-click to fit the content';
const dblClickEdge = (colIndex) => fireEvent.doubleClick(screen.getAllByTitle(EDGE_TITLE)[colIndex]);

beforeEach(() => {
  localStorage.clear();
  cellWidths = {};
  vi.clearAllMocks();
  act(() => __setTablePrefsCache({}));
});

describe('double-click to autofit', () => {
  it('saves the widest cell in that column, plus padding', () => {
    cellWidths = { '0:0': 60, '1:0': 220, '2:0': 140 };   // header 60, rows 220 / 140
    render(<Harness />);
    stubWidths();

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { name: 236 } });  // 220 + 16
  });

  it('measures the header too, so autofit never clips the label', () => {
    cellWidths = { '0:1': 300, '1:1': 40, '2:1': 40 };    // the header is the widest
    render(<Harness />);
    stubWidths();

    dblClickEdge(1);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 316 } });
  });

  it('measures the column that was double-clicked, not the first one', () => {
    cellWidths = { '1:0': 500, '1:2': 90 };
    render(<Harness />);
    stubWidths();

    dblClickEdge(2);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { due: 106 } });   // 90 + 16
  });

  it('never goes below the minimum width', () => {
    cellWidths = { '1:2': 4 };
    render(<Harness />);
    stubWidths();

    dblClickEdge(2);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { due: 60 } });    // MIN_W
  });

  it('caps a pathological cell rather than pushing every other column off screen', () => {
    cellWidths = { '1:0': 5000 };
    render(<Harness />);
    stubWidths();

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { name: 640 } });  // AUTOFIT_MAX_W
  });

  it('leaves the column alone when nothing in it can be measured', () => {
    render(<Harness />);   // every stub reports 0
    stubWidths();

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('keeps any width already set on the other columns', () => {
    act(() => __setTablePrefsCache({ t: { widths: { owner: 200 } } }));
    cellWidths = { '1:0': 100 };
    render(<Harness />);
    stubWidths();

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 200, name: 116 } });
  });

  it('does not leave the max-content probe behind in the template', () => {
    // The probe swaps the column to max-content for one layout. The template
    // then legitimately changes - to the fitted width - but a dropped restore
    // would strand max-content there and leave the table permanently mis-sized.
    cellWidths = { '1:0': 100 };
    render(<Harness />);
    stubWidths();

    dblClickEdge(0);

    const after = screen.getByTestId('wrap').style.getPropertyValue('--nx-grid');
    expect(after).not.toContain('max-content');
    expect(after).toBe('116px 150px 118px');
  });
});


// Why the gesture did not work at all until the fix below it:
//
//   the resize handle committed a width on EVERY mouseup, even one that never
//   moved; saving re-renders; and a table whose header is an inline component
//   (views/richlist.jsx's SortHead) rebuilds its whole header on a re-render.
//   So the first click of a double-click replaced the very node being clicked,
//   the two clicks landed on different elements, and the browser never raised
//   `dblclick`.
//
// Hence both halves: a press that never moved writes nothing, and the second
// press is recognised in mousedown rather than by the browser pairing clicks.
describe('the double-press is recognised without a dblclick event', () => {
  it('autofits on two quick presses of the same edge', () => {
    cellWidths = { '1:0': 100 };
    render(<Harness />);
    stubWidths();

    const edge = screen.getAllByTitle(EDGE_TITLE)[0];
    fireEvent.mouseDown(edge, { clientX: 50 });
    fireEvent.mouseUp(edge, { clientX: 50 });
    fireEvent.mouseDown(edge, { clientX: 50 });

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { name: 116 } });
  });

  it('does not autofit two presses on DIFFERENT columns', () => {
    cellWidths = { '1:0': 100, '1:1': 100 };
    render(<Harness />);
    stubWidths();

    fireEvent.mouseDown(screen.getAllByTitle(EDGE_TITLE)[0], { clientX: 50 });
    fireEvent.mouseUp(screen.getAllByTitle(EDGE_TITLE)[0], { clientX: 50 });
    fireEvent.mouseDown(screen.getAllByTitle(EDGE_TITLE)[1], { clientX: 90 });

    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('does not autofit two presses that are far apart in time', () => {
    vi.useFakeTimers();
    cellWidths = { '1:0': 100 };
    render(<Harness />);
    stubWidths();

    const edge = screen.getAllByTitle(EDGE_TITLE)[0];
    fireEvent.mouseDown(edge, { clientX: 50 });
    fireEvent.mouseUp(edge, { clientX: 50 });
    vi.setSystemTime(Date.now() + 2000);
    fireEvent.mouseDown(edge, { clientX: 50 });

    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('a press that never moved', () => {
  it('writes nothing - it is a click, not a resize', () => {
    // This write was the thing replacing the handle between the two clicks. It
    // also pinned a width on a column nobody had touched, which is what made
    // the Reset Columns button appear out of nowhere.
    render(<Harness />);
    const edge = screen.getAllByTitle(EDGE_TITLE)[0];

    fireEvent.mouseDown(edge, { clientX: 50 });
    fireEvent.mouseUp(edge, { clientX: 50 });

    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('still saves a width once the pointer actually moves', () => {
    render(<Harness />);
    const edge = screen.getAllByTitle(EDGE_TITLE)[0];

    fireEvent.mouseDown(edge, { clientX: 50 });
    fireEvent.mouseMove(window, { clientX: 130 });
    fireEvent.mouseUp(window, { clientX: 130 });

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { name: 230 } });  // 150 + 80
  });
});
