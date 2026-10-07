import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

// The Accounting module's shared controls (Oct 7): the entity tree, the one
// entity picker, the standard Customize, paging, column widths and the
// select-all box.

vi.mock('../../api', () => ({
  api: {
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));

import { CustomizeButton, EntitiesPicker, EntityPicker, Pager, SelectAllCheckbox, entityOptions, filterOptions } from './reportControls';
import { pageSlice, useColumnWidths, useCustomizePrefs, usePaged } from './tableHooks';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  resetAccountingPrefs();
});

// 66000 > 66001 > 66001-1, a historical parent with a child, and roots
// listed out of order.
const ENTITIES = [
  { code: '77000', name: 'Greens Fairfield' },
  { code: '66001-1', name: '108 Boselli Way, Georgetown', parent_code: '66001' },
  { code: '12000', name: 'Greens Global Inc' },
  { code: '66001', name: 'Boselli Holdings', parent_code: '66000' },
  { code: '66000', name: 'Greens Industrial' },
  { code: '66002', name: 'Industrial Circle', parent_code: '66000' },
  { code: '62005', name: 'Old Circle (H)', parent_code: '66000' },
  { code: '62005-1', name: 'Industrial Circle Lot 1', parent_code: '62005' },
  { code: '9000', name: 'Nine Thousand' },
];

describe('entityOptions', () => {
  it('builds the real tree to any depth, in number order at every level', () => {
    const out = entityOptions(ENTITIES);
    expect(out.map((o) => `${o.code}:${o.depth}`)).toEqual([
      '9000:0', '12000:0',
      '66000:0', '62005-1:1', '66001:1', '66001-1:2', '66002:1',
      '77000:0',
    ]);
    expect(out.find((o) => o.code === '66001-1').parent).toBe('66001');
  });

  it('hangs the child of a hidden historical parent under the nearest visible ancestor', () => {
    const out = entityOptions(ENTITIES);
    expect(out.some((o) => o.code === '62005')).toBe(false);
    expect(out.find((o) => o.code === '62005-1')).toMatchObject({ depth: 1, parent: '66000' });
  });

  it('shows historical entities when asked, or when one is kept', () => {
    const all = entityOptions(ENTITIES, { showHistorical: true });
    expect(all.map((o) => o.code)).toEqual(['9000', '12000', '66000', '62005', '62005-1', '66001', '66001-1', '66002', '77000']);
    expect(all.find((o) => o.code === '62005-1')).toMatchObject({ depth: 2, parent: '62005' });
    const kept = entityOptions(ENTITIES, { keep: ['62005'] });
    expect(kept.some((o) => o.code === '62005')).toBe(true);
  });

  it('survives a parent loop', () => {
    const out = entityOptions([{ code: 'A', name: 'a', parent_code: 'B' }, { code: 'B', name: 'b', parent_code: 'A' }]);
    expect(out.map((o) => o.code).sort()).toEqual(['A', 'B']);
  });
});

describe('filterOptions', () => {
  it('keeps the ancestors of a match on screen, dimmed', () => {
    const shown = filterOptions(entityOptions(ENTITIES), 'boselli way');
    expect(shown.map((o) => [o.code, !!o.dim])).toEqual([['66000', true], ['66001', true], ['66001-1', false]]);
  });
});

describe('EntityPicker', () => {
  it('finds an entity by its number and by its name, code shown on the left', () => {
    const onChange = vi.fn();
    render(<EntityPicker entities={ENTITIES} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    const box = screen.getByPlaceholderText('Search entity by name or code');
    fireEvent.change(box, { target: { value: '12000' } });
    const opt = screen.getByRole('option', { name: /Greens Global Inc/ });
    expect(opt.textContent.indexOf('12000')).toBeLessThan(opt.textContent.indexOf('Greens Global Inc'));
    fireEvent.click(opt);
    expect(onChange).toHaveBeenCalledWith('12000');

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: 'fairfield' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Search entity by name or code'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('77000');
  });

  it('moves with the arrow keys and picks with Enter', () => {
    const onChange = vi.fn();
    render(<EntityPicker entities={ENTITIES} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    const box = screen.getByPlaceholderText('Search entity by name or code');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('12000');
  });

  it('hides historical entities by default but keeps the current one, and draws extra top options', () => {
    const onChange = vi.fn();
    render(<EntityPicker entities={ENTITIES} value="62005" onChange={onChange} extra={[{ code: 'ALL', name: 'All Entities (Consolidated)' }]} />);
    expect(screen.getByRole('button', { name: 'Entity' }).textContent).toContain('Old Circle (H) (62005)');
    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(screen.getByRole('option', { name: /Old Circle/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'All Entities (Consolidated)' }));
    expect(onChange).toHaveBeenCalledWith('ALL');
  });

  it('splits the list under group headings and offers None', () => {
    const onChange = vi.fn();
    const ents = [{ code: '1', name: 'Mine' }, { code: '2', name: 'Partner Co', is_partner: true }];
    render(<EntityPicker entities={ents} value="1" onChange={onChange} noneLabel="None"
      groups={[{ label: 'Controllable', match: (e) => !e.is_partner }, { label: 'Partners', match: (e) => !!e.is_partner }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(screen.getByText('Controllable')).toBeTruthy();
    expect(screen.getByText('Partners')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('EntitiesPicker', () => {
  it('lists the tree with codes on the left', () => {
    render(<EntitiesPicker entities={ENTITIES} value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Entities' }));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.slice(0, 3)).toEqual(['9000Nine Thousand', '12000Greens Global Inc', '66000Greens Industrial']);
  });
});

describe('CustomizeButton', () => {
  it('uses the standard icon and draws only the options it is handed', () => {
    render(<CustomizeButton density="compact" onDensity={() => {}} />);
    const btn = screen.getByRole('button', { name: /Customize/ });
    expect(btn.querySelector('svg.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.getByRole('group', { name: 'Row Density' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Rows per Page' })).toBeNull();
    expect(screen.queryByText('Show Zero Balances')).toBeNull();
    expect(screen.queryByText('Show Historical Entities')).toBeNull();
    expect(screen.queryByText('Show Inactive Accounts')).toBeNull();
  });

  it('draws every shared option plus the screen\'s own', () => {
    const onPageSize = vi.fn();
    const onInactive = vi.fn();
    render(
      <CustomizeButton pageSize={0} onPageSize={onPageSize} showZero={false} onShowZero={() => {}} showHistorical={false} onShowHistorical={() => {}}
        showHistoricalAccounts={false} onShowHistoricalAccounts={() => {}} showInactiveAccounts={false} onShowInactiveAccounts={onInactive}>
        <div>Screen Option</div>
      </CustomizeButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.queryByRole('group', { name: 'Row Density' })).toBeNull();
    ['Show Zero Balances', 'Show Historical Entities', 'Show Historical Accounts', 'Show Inactive Accounts', 'Screen Option'].forEach((t) => expect(screen.getByText(t)).toBeTruthy());
    const inactive = screen.getByText('Show Inactive Accounts').closest('label').querySelector('input');
    expect(inactive.checked).toBe(false);
    fireEvent.click(inactive);
    expect(onInactive).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '100' }));
    expect(onPageSize).toHaveBeenCalledWith(100);
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Rows per page' }), { target: { value: '25' } });
    expect(onPageSize).toHaveBeenLastCalledWith(25);
  });

  it('useCustomizePrefs saves to the person\'s prefs and only wires the features asked for', () => {
    const { result } = renderHook(() => useCustomizePrefs(['pageSize', 'inactiveAccounts']));
    expect(result.current.onDensity).toBeUndefined();
    expect(result.current.pageSize).toBe(0);
    expect(result.current.showInactiveAccounts).toBe(false);
    act(() => { result.current.onPageSize(150); result.current.onShowInactiveAccounts(true); });
    expect(result.current.pageSize).toBe(150);
    expect(result.current.showInactiveAccounts).toBe(true);
  });
});

describe('paging', () => {
  it('pageSlice does the math', () => {
    expect(pageSlice(312, 50, 2)).toMatchObject({ page: 2, pages: 7, start: 50, end: 100, from: 51, to: 100, total: 312 });
    expect(pageSlice(312, 50, 7)).toMatchObject({ page: 7, from: 301, to: 312 });
    expect(pageSlice(312, 50, 99)).toMatchObject({ page: 7 });
    expect(pageSlice(312, 0, 3)).toMatchObject({ page: 1, pages: 1, start: 0, end: 312, from: 1, to: 312 });
    expect(pageSlice(0, 50, 1)).toMatchObject({ pages: 0, from: 0, to: 0, total: 0 });
  });

  it('Pager reads "Page 2 of 7 · Rows 51-100 of 312" and steps', () => {
    const setPage = vi.fn();
    render(<Pager page={2} pages={7} from={51} to={100} total={312} setPage={setPage} />);
    expect(screen.getByRole('status').textContent).toBe('Page 2 of 7 · Rows 51-100 of 312');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(setPage).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: /Previous/ }));
    expect(setPage).toHaveBeenCalledWith(1);
  });

  it('Pager draws nothing when everything fits', () => {
    const { container } = render(<Pager page={1} pages={1} from={1} to={10} total={10} setPage={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('usePaged slices and goes back to page 1 when the filters change', () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const { result, rerender } = renderHook(({ key }) => usePaged(rows, 50, key), { initialProps: { key: 'a' } });
    expect(result.current.rows).toHaveLength(50);
    act(() => result.current.setPage(3));
    expect(result.current.rows).toEqual(rows.slice(100));
    expect(result.current).toMatchObject({ page: 3, pages: 3, from: 101, to: 120 });
    rerender({ key: 'b' });
    expect(result.current.page).toBe(1);
    expect(result.current.rows[0]).toBe(0);
  });
});

describe('useColumnWidths', () => {
  it('keeps a width per table, clamps to the minimum, and forgets on reset', () => {
    const { result } = renderHook(() => useColumnWidths('gl', { memo: 200 }, { min: 80 }));
    expect(result.current.width('memo')).toBe(200);
    expect(result.current.width('entity')).toBeUndefined();
    act(() => { const r = result.current.resizer('memo', 'Memo'); r.onDrag(40); });
    expect(result.current.width('memo')).toBe(80);
    act(() => result.current.resizer('memo').onEnd());
    expect(result.current.width('memo')).toBe(80);
    act(() => result.current.resizer('memo').onFit(310));
    expect(result.current.width('memo')).toBe(310);
    const other = renderHook(() => useColumnWidths('tb'));
    expect(other.result.current.width('memo')).toBeUndefined();
    act(() => result.current.reset('memo'));
    expect(result.current.width('memo')).toBe(200);
  });
});

describe('SelectAllCheckbox', () => {
  it('is ticked, mixed or empty, and flips everything', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SelectAllCheckbox checked={3} total={10} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Select All' });
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<SelectAllCheckbox checked={10} total={10} onChange={onChange} />);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
