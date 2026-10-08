import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Reporting -> AMA (Oct 7): the agreements render (a render
// smoke test - a crash here would blank the screen), the fee text, a failed
// ledger read on one row, Billed YTD opening the ledger lines, the editor's
// inline validation and save, the trash confirmed in place, the empty state
// and a plain error.

const row = (over = {}) => ({
  id: 'A1', entityCode: '15000', managerEntityCode: '90000', status: 'Active', feeBasis: 'percent_revenue', feeRate: 3.5, flatAmount: null,
  billingFrequency: 'Monthly', startDate: '2026-01-01', endDate: '', feeGlAccount: '40500', agreementUrl: 'https://greens.egnyte.com/fl/abc', notes: '',
  billingEntityCode: '90000', year: 2026, asOf: '2026-10-07', billedYtd: 1000, expectedYtd: 3500, difference: -2500, revenueYtd: 100000,
  periodsElapsed: 10, nextBilling: '2026-11-01', error: null, ...over,
});
const summary = {
  year: 2026, asOf: '2026-10-07',
  rows: [
    row(),
    row({ id: 'A2', entityCode: '56000', managerEntityCode: '', status: 'Pending Review', feeBasis: 'flat', feeRate: null, flatAmount: 2500, billingFrequency: 'Quarterly',
      agreementUrl: '', billedYtd: null, expectedYtd: null, difference: null, error: 'The accounting app did not answer.', nextBilling: '2026-10-15' }),
  ],
};

vi.mock('../../api', () => ({
  api: {
    getAmaSummary: vi.fn(async () => summary),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }, { code: '90000', name: 'Greens Asset Management' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    createAmaAgreement: vi.fn(async (b) => ({ ...b, id: 'A9' })),
    updateAmaAgreement: vi.fn(async (id, b) => ({ ...b, id })),
    deleteAmaAgreement: vi.fn(async () => null),
  },
}));
vi.mock('./drill', () => ({ requestReportDrill: vi.fn() }));

import AmaTab, { feeText, validateAgreement } from './AmaTab';
import { api } from '../../api';
import { requestReportDrill } from './drill';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getAmaSummary.mockImplementation(async () => summary);
});

describe('AmaTab', () => {
  it('renders the agreements with fees, figures and the next billing date', async () => {
    render(<AmaTab canEdit />);
    expect(screen.getByText('Asset Management Agreements')).toBeTruthy();
    const name = await screen.findByText('15000 Greens Escondido, LLC.');
    const tr = name.closest('tr');
    expect(within(tr).getByText('90000 Greens Asset Management')).toBeTruthy();
    expect(within(tr).getByText('3.50% of revenue')).toBeTruthy();
    expect(within(tr).getByText('1,000.00')).toBeTruthy();
    expect(within(tr).getByText('(2,500.00)')).toBeTruthy();
    expect(within(tr).getByText('11/01/2026')).toBeTruthy();
    expect(within(tr).getByRole('link', { name: /View Agreement/ }).getAttribute('target')).toBe('_blank');
    const other = screen.getByText('56000 MCD Services, Inc.').closest('tr');
    expect(within(other).getByText('$2,500.00 Quarterly')).toBeTruthy();
    expect(within(other).getByText('Pending Review')).toBeTruthy();
    expect(within(other).getByText('Not Read').getAttribute('title')).toMatch(/did not answer/);
  });

  it('opens the ledger lines behind Billed YTD', async () => {
    render(<AmaTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: /Ledger lines behind the billed fee/ }));
    expect(requestReportDrill).toHaveBeenCalledWith(expect.objectContaining({ account: '40500', entity: '90000', from: '2026-01-01', to: '2026-10-07' }));
  });

  it('validates inline and saves a new agreement', async () => {
    render(<AmaTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    fireEvent.click(screen.getByRole('button', { name: /Add Agreement/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Agreement' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    expect(within(dialog).getByText('Pick the managed entity.')).toBeTruthy();
    expect(within(dialog).getByText('Pick the start date.')).toBeTruthy();
    expect(api.createAmaAgreement).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Managed Entity' }));
    fireEvent.click(await screen.findByText(/Greens Escondido, LLC\./, { selector: '[role="option"] *, [role="option"]' }));
    fireEvent.change(within(dialog).getByLabelText('Fee Rate %'), { target: { value: '3.5' } });
    fireEvent.change(within(dialog).getByLabelText('Start Date'), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('Agreement Link'), { target: { value: 'https://example.com/a.pdf' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    await waitFor(() => expect(api.createAmaAgreement).toHaveBeenCalledWith(expect.objectContaining({
      entityCode: '15000', feeBasis: 'percent_revenue', feeRate: 3.5, flatAmount: null, startDate: '2026-01-01', agreementUrl: 'https://example.com/a.pdf',
    })));
  });

  it('removes an agreement only after Remove is confirmed in place', async () => {
    render(<AmaTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the agreement of 15000 Greens Escondido, LLC.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.deleteAmaAgreement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the agreement of 15000 Greens Escondido, LLC.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteAmaAgreement).toHaveBeenCalledWith('A1'));
  });

  it('hides editing from viewers and shows the empty state', async () => {
    api.getAmaSummary.mockImplementation(async () => ({ year: 2026, asOf: '2026-10-07', rows: [] }));
    render(<AmaTab />);
    expect(await screen.findByText('No asset management agreements yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add Agreement/ })).toBeNull();
  });

  it('shows a plain error with Try Again', async () => {
    api.getAmaSummary.mockImplementation(async () => { throw new Error('Server error'); });
    render(<AmaTab canEdit />);
    expect(await screen.findByText('Server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('formats fees and validates fields', () => {
    expect(feeText({ feeBasis: 'flat', flatAmount: 2500, billingFrequency: 'Monthly' })).toBe('$2,500.00 Monthly');
    expect(feeText({ feeBasis: 'percent_revenue', feeRate: 3.5 })).toBe('3.50% of revenue');
    const ok = { entityCode: '15000', managerEntityCode: '', feeBasis: 'flat', flatAmount: 10, startDate: '2026-01-01', endDate: '', agreementUrl: '' };
    expect(validateAgreement(ok)).toEqual({});
    expect(Object.keys(validateAgreement({ ...ok, managerEntityCode: '15000', endDate: '2025-01-01', agreementUrl: 'javascript:alert(1)', flatAmount: 0 })).sort())
      .toEqual(['agreementUrl', 'endDate', 'flatAmount', 'managerEntityCode']);
  });
});
