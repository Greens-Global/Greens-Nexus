import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ASSETS, STORE, TODAY } from './fixture.test-data.js';
import { DatesTab } from './DatesTab.jsx';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(TODAY); });
afterAll(() => { vi.useRealTimers(); });
afterEach(cleanup);

const rowOf = (text) => screen.getByText(text).closest('tr');

describe('DatesTab', () => {
  it('sums up, groups by month with Passed first and Check These Dates', () => {
    render(<DatesTab store={STORE} assets={ASSETS} canEdit />);
    expect(screen.getByText('3 dates passed without being marked done')).toBeTruthy();
    expect(screen.getByText('4 due in the next 90 days')).toBeTruthy();
    expect(screen.getByText('only 2 of 5 assets have an insurance expiration on file')).toBeTruthy();
    expect(screen.getByText('1 date looks mistyped')).toBeTruthy();
    const groups = screen.getAllByRole('row').map((r) => r.textContent);
    const order = ['Passed', 'Check These Dates', 'December 2026', 'January 2027'].map((g) => groups.indexOf(g));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(screen.getByText('Permit expiration')).toBeTruthy();   // the Building permit, 01/15/2027
    expect(screen.queryByText('March 2027')).toBeNull();          // the roof warranty is past 90 days
    const dec = rowOf('2 properties');
    expect(within(dec).getByText('12/10/2026')).toBeTruthy();
    expect(within(dec).getByText('In 23 days')).toBeTruthy();
    expect(screen.getByText('Check this date')).toBeTruthy();
  });

  it('Mark All Paid rolls each property one year on, one patch per asset', () => {
    const onPatchAsset = vi.fn();
    render(<DatesTab store={STORE} assets={ASSETS} onPatchAsset={onPatchAsset} canEdit />);
    fireEvent.click(within(rowOf('2 properties')).getByText('Mark All Paid'));
    expect(onPatchAsset).toHaveBeenCalledTimes(2);
    expect(onPatchAsset).toHaveBeenCalledWith('mur', { taxDue: '12/10/2027' }, [{ field: 'Due Dates', from: '12/10/2026', to: '12/10/2027' }]);
    expect(onPatchAsset).toHaveBeenCalledWith('tem', { taxDue: '12/10/2027, 11/01/2026' }, expect.any(Array));
  });

  it('a collapsed row opens to its assets; Fix opens the property', () => {
    const openAsset = vi.fn();
    render(<DatesTab store={STORE} assets={ASSETS} openAsset={openAsset} canEdit />);
    fireEvent.click(rowOf('2 properties'));
    expect(screen.getAllByText('Greens Storage, Temecula').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText('Fix'));
    expect(openAsset).toHaveBeenCalledWith('esc', 'property', '');
  });

  it('viewers get no Mark buttons; Missing lists assets without a date', () => {
    render(<DatesTab store={STORE} assets={ASSETS} />);
    expect(screen.queryByText(/^Mark /)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Missing' }));
    expect(screen.getByText('No insurance expiration')).toBeTruthy();
    expect(screen.getAllByText('Add Date').length).toBe(3);
  });
  it('an editor fills a missing date on the row: one patch, in the format on file', () => {
    const onPatchAsset = vi.fn();
    const openAsset = vi.fn();
    render(<DatesTab store={STORE} assets={ASSETS} onPatchAsset={onPatchAsset} openAsset={openAsset} canEdit />);
    fireEvent.click(screen.getByRole('radio', { name: 'Missing' }));
    const boxes = screen.getAllByRole('button', { name: 'Add Date' });
    expect(boxes.length).toBe(3);
    expect(screen.getAllByText('Open').length).toBe(3);
    // The calendar opens on the row; picking a day is the save.
    fireEvent.click(boxes[0]);
    const day = screen.getAllByRole('button').find((b) => /^15$/.test(b.textContent.trim()));
    expect(day).toBeTruthy();
    fireEvent.click(day);
    expect(onPatchAsset).toHaveBeenCalledTimes(1);
    const [id, patch, changes] = onPatchAsset.mock.calls[0];
    const key = Object.keys(patch)[0];
    expect(['taxDue', 'insExpiration', 'regExpiration']).toContain(key);
    expect(patch[key]).toMatch(/^\d{2}\/15\/\d{4}$/);
    expect(changes).toEqual([{ field: expect.any(String), from: '', to: patch[key] }]);
    expect(typeof id).toBe('string');
    expect(openAsset).not.toHaveBeenCalled();
  });
});
