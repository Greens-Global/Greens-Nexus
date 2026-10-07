import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Data (Oct 7): no browser dialogs. A schedule that is not
// JSON and a save the server refuses say so in a line under the row (no
// window.alert); Delete asks in place (Remove / Keep, no window.confirm);
// the entity cells are the module's entity picker, found by number.

const act = vi.fn(async () => ({ ok: true }));
const tables = {
  loans: [{ id: 'FL1', loan_no: '6870', kind: 'external', lender: 'F&M Bank', entity_code: '15000', gl_account: '27100', balance_source: 'manual', balance: 1000, rate_pct: 6, rate_type: 'fixed', maturity: null, monthly_pi: 0, dscr: null, covenant_min: null, is_active: true }],
  deadlines: [{ id: 'D1', title: 'Property Tax', owner: 'Charmi', kind: 'dates', schedule: [[4, 10]], sort: 1, is_active: true }],
};
const ix = { roots: [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }] };

vi.mock('./DashContext', () => ({ useDash: () => ({ tables, tablesLoading: false, act, ix }) }));

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

  it('asks in place before deleting a row', async () => {
    render(<DataTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    const ask = screen.getByRole('group', { name: 'Delete this row?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep' }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('row-delete', { table: 'fin_loans', match: { id: 'FL1' } }));
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
