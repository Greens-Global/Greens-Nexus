import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act as rtlAct } from '@testing-library/react';
import { HOLD_RECORD_MS } from '../../../ui/HoldButton';

// Accounting -> Data (Oct 7): no browser dialogs. A schedule that is not
// JSON and a save the server refuses say so in a line under the row (no
// window.alert); Delete is a press and hold on the row (no window.confirm);
// the entity cells are the module's entity picker, found by number.

const act = vi.fn(async () => ({ ok: true }));
const tables = {
  loans: [{ id: 'FL1', loan_no: '6870', kind: 'external', lender: 'F&M Bank', entity_code: '15000', gl_account: '27100', balance_source: 'manual', balance: 1000, rate_pct: 6, rate_type: 'fixed', maturity: null, monthly_pi: 0, dscr: null, covenant_min: null, is_active: true }],
  deadlines: [{ id: 'D1', title: 'Property Tax', owner: 'Charmi', kind: 'dates', schedule: [[4, 10]], sort: 1, is_active: true }],
};
const ix = { roots: [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }] };

vi.mock('./DashContext', () => ({ useBooksDown: () => false, useDash: () => ({ tables, tablesLoading: false, act, ix }) }));

import DataTab from './DataTab';

let alertSpy;
let confirmSpy;
beforeEach(() => {
  act.mockReset();
  act.mockImplementation(async () => ({ ok: true }));
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
});
afterEach(() => { alertSpy.mockRestore(); confirmSpy.mockRestore(); });

describe('DataTab', () => {
  it('says inline, not in an alert, when a schedule is not JSON', async () => {
    render(<DataTab />);
    fireEvent.click(screen.getByRole('tab', { name: 'Filing Calendar' }));
    const box = screen.getByLabelText('Schedule');
    fireEvent.change(box, { target: { value: '[[4,' } });
    fireEvent.blur(box);
    expect((await screen.findByRole('alert')).textContent).toMatch(/schedule must be JSON/);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('says inline when the server will not save the row', async () => {
    act.mockImplementation(async () => { throw new Error('Lender is required'); });
    render(<DataTab />);
    const lender = screen.getByLabelText('Lender');
    fireEvent.change(lender, { target: { value: 'Chase' } });
    fireEvent.blur(lender);
    expect((await screen.findByRole('alert')).textContent).toBe('Lender is required');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('deletes a saved row only after a press and hold', async () => {
    render(<DataTab />);
    const del = screen.getByRole('button', { name: 'Delete row, press and hold' });
    vi.useFakeTimers();
    try {
      // A quick tap does nothing.
      fireEvent.pointerDown(del, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(del, { pointerId: 1 });
      expect(act).not.toHaveBeenCalled();
      fireEvent.pointerDown(del, { button: 0, pointerId: 1 });
      await rtlAct(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    } finally { vi.useRealTimers(); }
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(act).toHaveBeenCalledWith('row-delete', { table: 'fin_loans', match: { id: 'FL1' } });
  });

  it('says why when Seed Defaults is refused', async () => {
    act.mockImplementation(async () => { throw new Error('Seeding is off'); });
    render(<DataTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Seed Defaults' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Seeding is off');
  });

  it('picks the entity with the module picker, by number', async () => {
    render(<DataTab />);
    const pick = screen.getByRole('button', { name: 'Entity / Property' });
    expect(pick.textContent).toContain('Greens Escondido, LLC. (15000)');
    fireEvent.click(pick);
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '56000' } });
    fireEvent.click(screen.getByRole('option', { name: /MCD Services/ }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('row-save', expect.objectContaining({ table: 'fin_loans', row: expect.objectContaining({ entity_code: '56000' }) })));
  });

  it('has no browser alert or confirm in its source', async () => {
    const src = (await import('./DataTab.jsx?raw')).default;
    expect(src).not.toMatch(/window\.(alert|confirm)\(/);
  });
});
