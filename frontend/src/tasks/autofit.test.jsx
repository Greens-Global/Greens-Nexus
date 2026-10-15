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

// ── The Task List's leading checkbox, room, and the column that fills ───────
// The rows of the Task List (MyTasksView) are '16px var(--nx-grid)': a select
// checkbox, then the shared columns. Autofit read children[idx], so every fit
// there measured the column to the LEFT - Project sized from the avatars,
// Name from the 16px checkbox.

const tracksOf = (tpl) => {
  const out = []; let cur = '', depth = 0;
  for (const ch of tpl) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

function CheckboxHarness({ cols = COLS }) {
  const { cols: ordered, template, widths, startResize, autofitWidth, wrapRef } =
    useTableColumns({ table: 't', cols });
  const grid = '16px var(--nx-grid)';
  return (
    <div ref={wrapRef} style={{ '--nx-grid': template }} data-testid="wrap">
      <div style={{ display: 'grid', gridTemplateColumns: grid }} data-testid="header">
        <span>☐</span>
        {ordered.map((c) => (
          <TableHead key={c.key} label={c.label}
            onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 150)}
            onResizeAutofit={() => autofitWidth(c.key)} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: grid }} data-testid="row0">
        <span>☐</span>
        {ordered.map((c) => <div key={c.key}>{c.key}</div>)}
      </div>
    </div>
  );
}

describe('rows with their own tracks in front of the shared ones', () => {
  it('measures the cell after the checkbox, not the one before it', () => {
    render(<CheckboxHarness />);
    // children: [checkbox, name, owner, due] - widths per child index
    const header = [16, 40, 50, 30], row = [16, 300, 180, 90];
    Array.from(screen.getByTestId('header').children).forEach((cell, i) => { cell.getBoundingClientRect = () => ({ width: header[i] }); });
    Array.from(screen.getByTestId('row0').children).forEach((cell, i) => { cell.getBoundingClientRect = () => ({ width: row[i] }); });

    dblClickEdge(1);   // Owner

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 196 } });   // 180 + 16, not the name's 300
  });
});

// A fake layout for the header row: the container is `room` wide, the filler
// column never goes below `fillMin`, and the grid overflows by whatever the
// tracks need past that. Cell widths follow the current template too, so the
// filler's share and the max-content probe each read what a browser would.
function fakeLayout({ room, fillMin, content }) {
  const wrap = screen.getByTestId('wrap');
  const tracks = () => tracksOf(wrap.style.getPropertyValue('--nx-grid'));
  const px = (t) => (t.endsWith('px') ? parseFloat(t) : 0);
  const fixedSum = (ts) => ts.reduce((s, t) => s + (t.startsWith('minmax') ? 0 : px(t)), 0);
  const header = screen.getByTestId('header');
  Object.defineProperty(header, 'clientWidth', { configurable: true, get: () => room });
  Object.defineProperty(header, 'scrollWidth', {
    configurable: true,
    get: () => { const ts = tracks(); return Math.max(room, fixedSum(ts) + (ts.some((t) => t.startsWith('minmax')) ? fillMin : 0)); },
  });
  ['header', 'row0', 'row1'].forEach((id, ri) => {
    Array.from(screen.getByTestId(id).children).forEach((cell, ci) => {
      cell.getBoundingClientRect = () => {
        const t = tracks()[ci];
        if (t === 'max-content') return { width: content[`${ri}:${ci}`] ?? 0 };
        if (t.startsWith('minmax')) { const ts = tracks(); return { width: Math.max(fillMin, room - fixedSum(ts)) }; }
        return { width: px(t) };
      };
    });
  });
}

const FILL_COLS = [
  { key: 'name', label: 'Name', template: 'minmax(220px,1fr)' },
  { key: 'owner', label: 'Owner', width: 150 },
  { key: 'due', label: 'Due', width: 118 },
];

describe('fitting within the room the table has', () => {
  it('caps a column so a table that fits its container still fits', () => {
    render(<Harness cols={FILL_COLS} />);
    // 700 wide: Name keeps 220 and Due 118, which leaves Owner 362
    fakeLayout({ room: 700, fillMin: 220, content: { '0:1': 50, '1:1': 520 } });

    dblClickEdge(1);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 362 } });
  });

  it('takes the full fit when there is room for it', () => {
    render(<Harness cols={FILL_COLS} />);
    fakeLayout({ room: 1400, fillMin: 220, content: { '0:1': 50, '1:1': 520 } });

    dblClickEdge(1);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 536 } });
  });

  it('does not cap a table that scrolls sideways anyway', () => {
    render(<Harness cols={FILL_COLS} />);
    // 300 wide: even with Owner at its minimum the table overflows
    fakeLayout({ room: 300, fillMin: 220, content: { '1:1': 520 } });

    dblClickEdge(1);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 536 } });
  });

  it('never caps below the header label', () => {
    render(<Harness cols={FILL_COLS} />);
    // only 400 for Owner+Due+Name's 220: the label (90 + 16) still wins
    fakeLayout({ room: 400, fillMin: 220, content: { '0:1': 90, '1:1': 520 } });

    dblClickEdge(1);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 106 } });
  });
});

describe('the column that fills the row', () => {
  it('goes back to filling when its content fits the share it gets', () => {
    act(() => __setTablePrefsCache({ t: { widths: { name: 260, owner: 200 } } }));
    render(<Harness cols={FILL_COLS} />);
    // 1000 wide: as a filler Name gets 1000 - 200 - 118 = 682 > 400 + 16
    fakeLayout({ room: 1000, fillMin: 220, content: { '1:0': 400 } });

    dblClickEdge(0);
    dblClickEdge(0);   // a second run lands on the same answer

    expect(api.saveTaskTablePrefs).toHaveBeenCalledTimes(1);   // already filling the second time
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { owner: 200 } });
  });

  it('writes nothing when it is already filling and its content fits', () => {
    render(<Harness cols={FILL_COLS} />);
    fakeLayout({ room: 1000, fillMin: 220, content: { '1:0': 400 } });

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('pins to its content when that is wider than its share', () => {
    render(<Harness cols={FILL_COLS} />);
    // as a filler Name gets 600 - 150 - 118 = 332 < 500 + 16
    fakeLayout({ room: 600, fillMin: 220, content: { '1:0': 500 } });

    dblClickEdge(0);

    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: { name: 516 } });
  });
});
