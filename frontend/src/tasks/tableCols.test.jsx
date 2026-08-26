// The column kit backs four tables (My Tasks, the Task List, Projects,
// Portfolios), so a regression here is a regression in all of them.
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
import { nextSort, applyOrder, useTableColumns, TableHead, useTableSetting, useTableValue, __setTablePrefsCache } from './tableCols';

describe('nextSort', () => {
  it('cycles unsorted -> asc -> desc -> reset', () => {
    const reset = { key: 'manual', dir: 'asc' };
    expect(nextSort(null, 'name', reset)).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name', reset)).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name', reset)).toEqual(reset);
  });

  it('starts a NEW column at ascending rather than continuing the old cycle', () => {
    expect(nextSort({ key: 'due', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('defaults the reset state to null for tables with no manual order', () => {
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toBeNull();
  });
});

const COLS = [
  { key: 'check', label: '', width: 28, fixed: true },
  { key: 'name', label: 'Name', template: 'minmax(220px,1fr)' },
  { key: 'due', label: 'Due', width: 118 },
  { key: 'owner', label: 'Owner', width: 150 },
];

describe('applyOrder', () => {
  const keys = (cols) => cols.map((c) => c.key);

  it('leaves the defaults alone when nothing has been arranged', () => {
    expect(keys(applyOrder(COLS, undefined))).toEqual(['check', 'name', 'due', 'owner']);
    expect(keys(applyOrder(COLS, []))).toEqual(['check', 'name', 'due', 'owner']);
  });

  it('applies a saved order to the movable columns', () => {
    expect(keys(applyOrder(COLS, ['owner', 'due', 'name']))).toEqual(['check', 'owner', 'due', 'name']);
  });

  it('never moves a fixed column out of its slot', () => {
    // "check" is structure, not data - a saved order must not be able to
    // displace it even if it names it.
    expect(keys(applyOrder(COLS, ['owner', 'check', 'name', 'due']))[0]).toBe('check');
  });

  it('ignores a saved key whose column no longer exists', () => {
    expect(keys(applyOrder(COLS, ['retired', 'owner', 'name', 'due'])))
      .toEqual(['check', 'owner', 'name', 'due']);
  });

  it('puts a column that did not exist when the order was saved after the arranged ones', () => {
    // A shipped new column must degrade to "at the end", never to a dropped
    // column or a crash.
    expect(keys(applyOrder(COLS, ['owner', 'name']))).toEqual(['check', 'owner', 'name', 'due']);
  });
});

const HANDLE = 'Drag to resize, double-click to reset';

function Harness({ table = 't' }) {
  const { cols, template, widths, startResize, resetWidth, dragProps, wrapRef } =
    useTableColumns({ table, cols: COLS });
  return (
    <div ref={wrapRef} style={{ '--nx-grid': template }}>
      <span data-testid="template">{template}</span>
      <span data-testid="order">{cols.map((c) => c.key).join(',')}</span>
      <span data-testid="due-width">{String(widths.due ?? '')}</span>
      {cols.map((c) => (
        <TableHead key={c.key} label={c.label || c.key} sortKey={c.key} sort={null} setSort={() => {}}
          drag={dragProps(c.key, !c.fixed)}
          onResizeStart={startResize(c.key, widths[c.key] ?? c.width ?? 150)}
          onResizeReset={() => resetWidth(c.key)} />
      ))}
    </div>
  );
}

const dragTransfer = () => ({ setData: vi.fn(), dropEffect: '', effectAllowed: '' });

describe('useTableColumns', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    act(() => __setTablePrefsCache({}));
  });

  it('builds a template from each column’s own sizing until one is dragged', () => {
    render(<Harness />);
    expect(screen.getByTestId('template').textContent).toBe('28px minmax(220px,1fr) 118px 150px');
  });

  it('saves a dragged width to the user’s profile on release', () => {
    render(<Harness />);
    fireEvent.mouseDown(screen.getAllByTitle(HANDLE)[2], { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 160 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId('due-width').textContent).toBe('178');
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { widths: expect.objectContaining({ due: 178 }) });
  });

  it('never shrinks a column below the minimum, however far left you drag', () => {
    render(<Harness />);
    fireEvent.mouseDown(screen.getAllByTitle(HANDLE)[2], { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: -900 });
    fireEvent.mouseUp(window);
    expect(Number(screen.getByTestId('due-width').textContent)).toBe(60);
  });

  it('double-clicking the handle puts the column back to its default', () => {
    act(() => __setTablePrefsCache({ t: { widths: { due: 240 } } }));
    render(<Harness />);
    expect(screen.getByTestId('template').textContent).toContain('240px');
    fireEvent.dblClick(screen.getAllByTitle(HANDLE)[2]);
    expect(screen.getByTestId('template').textContent).toBe('28px minmax(220px,1fr) 118px 150px');
  });

  it('renders a saved order and keeps the fixed column in place', () => {
    act(() => __setTablePrefsCache({ t: { order: ['owner', 'due', 'name'] } }));
    render(<Harness />);
    expect(screen.getByTestId('order').textContent).toBe('check,owner,due,name');
  });

  it('saves a new order when one header is dropped on another', () => {
    render(<Harness />);
    const owner = screen.getByText('Owner');
    const name = screen.getByText('Name');
    fireEvent.dragStart(owner, { dataTransfer: dragTransfer() });
    fireEvent.dragOver(name, { dataTransfer: dragTransfer() });
    fireEvent.drop(name, { dataTransfer: dragTransfer() });
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { order: ['owner', 'name', 'due'] });
    expect(screen.getByTestId('order').textContent).toBe('check,owner,name,due');
  });

  it('does nothing when a column is dropped on itself', () => {
    render(<Harness />);
    const due = screen.getByText('Due');
    fireEvent.dragStart(due, { dataTransfer: dragTransfer() });
    fireEvent.drop(due, { dataTransfer: dragTransfer() });
    expect(api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('keeps the table usable when the profile cannot be read', async () => {
    api.getTaskTablePrefs.mockRejectedValueOnce(new Error('offline'));
    act(() => __setTablePrefsCache(null));
    render(<Harness table="offline-table" />);
    expect(screen.getByTestId('order').textContent).toBe('check,name,due,owner');
  });

  it('keeps the arrangement on screen when the save fails', () => {
    api.saveTaskTablePrefs.mockRejectedValueOnce(new Error('500'));
    render(<Harness />);
    fireEvent.dragStart(screen.getByText('Owner'), { dataTransfer: dragTransfer() });
    fireEvent.drop(screen.getByText('Name'), { dataTransfer: dragTransfer() });
    // Optimistic: what the user just did stays put rather than snapping back.
    expect(screen.getByTestId('order').textContent).toBe('check,owner,name,due');
  });
});

describe('TableHead', () => {
  it('drives the sort cycle from a click', () => {
    let sort = null;
    const setSort = (fn) => { sort = fn(sort); };
    const { rerender } = render(<TableHead label="Due" sortKey="due" sort={sort} setSort={setSort} />);
    fireEvent.click(screen.getByText('Due'));
    expect(sort).toEqual({ key: 'due', dir: 'asc' });
    rerender(<TableHead label="Due" sortKey="due" sort={sort} setSort={setSort} />);
    fireEvent.click(screen.getByText('Due'));
    expect(sort).toEqual({ key: 'due', dir: 'desc' });
  });

  it('is inert when the column has no sort key', () => {
    const setSort = vi.fn();
    render(<TableHead label="Actions" sort={null} setSort={setSort} />);
    fireEvent.click(screen.getByText('Actions'));
    expect(setSort).not.toHaveBeenCalled();
  });
});

// Everything a person customizes has to survive leaving the screen - that is
// the whole point of storing it in the profile rather than in component state.
function SettingHarness({ name, fallback }) {
  const [list, setList] = useTableSetting('t', name, fallback);
  return (
    <div>
      <span data-testid="value">{JSON.stringify(list)}</span>
      <button onClick={() => setList([])}>clear</button>
      <button onClick={() => setList(['completed'])}>collapse</button>
    </div>
  );
}

const EMPTY = [];
const DEFAULT_COLLAPSED = ['completed'];

describe('useTableSetting', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    act(() => __setTablePrefsCache({}));
  });

  it('uses the fallback when the person has never set it', () => {
    render(<SettingHarness name="collapsed" fallback={DEFAULT_COLLAPSED} />);
    expect(screen.getByTestId('value').textContent).toBe('["completed"]');
  });

  it('treats a stored empty list as a real value, not as unset', () => {
    // This is what lets someone re-open a section that ships collapsed by
    // default; reading [] as "unset" would close it again on every visit.
    act(() => __setTablePrefsCache({ t: { collapsed: [] } }));
    render(<SettingHarness name="collapsed" fallback={DEFAULT_COLLAPSED} />);
    expect(screen.getByTestId('value').textContent).toBe('[]');
  });

  it('saves a change to the profile', () => {
    render(<SettingHarness name="hidden" fallback={EMPTY} />);
    fireEvent.click(screen.getByText('collapse'));
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { hidden: ['completed'] });
    expect(screen.getByTestId('value').textContent).toBe('["completed"]');
  });

  it('accepts a Set and stores it as a list', () => {
    const Harness = () => {
      const [, set] = useTableSetting('t', 'hidden', EMPTY);
      return <button onClick={() => set(new Set(['a', 'b']))}>go</button>;
    };
    render(<Harness />);
    fireEvent.click(screen.getByText('go'));
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { hidden: ['a', 'b'] });
  });
});

function ValueHarness() {
  const [sort, setSort] = useTableValue('t', 'sort', { key: 'manual', dir: 'asc' });
  return (
    <div>
      <span data-testid="sort">{`${sort.key}:${sort.dir}`}</span>
      <button onClick={() => setSort({ key: 'dueOn', dir: 'asc' })}>set</button>
      <button onClick={() => setSort((prev) => ({ key: prev.key, dir: 'desc' }))}>flip</button>
    </div>
  );
}

describe('useTableValue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    act(() => __setTablePrefsCache({}));
  });

  it('falls back until the person has chosen', () => {
    render(<ValueHarness />);
    expect(screen.getByTestId('sort').textContent).toBe('manual:asc');
  });

  it('restores what they last chose', () => {
    act(() => __setTablePrefsCache({ t: { sort: { key: 'dueOn', dir: 'desc' } } }));
    render(<ValueHarness />);
    expect(screen.getByTestId('sort').textContent).toBe('dueOn:desc');
  });

  it('saves a direct value', () => {
    render(<ValueHarness />);
    fireEvent.click(screen.getByText('set'));
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { sort: { key: 'dueOn', dir: 'asc' } });
  });

  it('supports a functional updater - setSort is called that way', () => {
    act(() => __setTablePrefsCache({ t: { sort: { key: 'dueOn', dir: 'asc' } } }));
    render(<ValueHarness />);
    fireEvent.click(screen.getByText('flip'));
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('t', { sort: { key: 'dueOn', dir: 'desc' } });
  });
});
