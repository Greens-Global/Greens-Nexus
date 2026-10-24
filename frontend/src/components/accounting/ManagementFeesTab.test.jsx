import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Reporting -> Management Fees (Oct 7, renamed from AMA Oct 15): the agreements render (a render
// smoke test - a crash here would blank the screen), the fee text, a failed
// ledger read on one row, Billed YTD opening the ledger lines, the editor's
// inline validation and save, the trash confirmed in place, the empty state
// and a plain error.

const row = (over = {}) => ({
  id: 'A1', entityCode: '15000', managerEntityCode: '90000', status: 'Active', feeBasis: 'percent_revenue', feeRate: 3.5, flatAmount: null,
  billingFrequency: 'Monthly', startDate: '2026-01-01', endDate: '', feeGlAccount: '40500', agreementUrl: 'https://greens.egnyte.com/fl/abc', notes: '',
  billingEntityCode: '90000', year: 2026, asOf: '2026-10-07', billedYtd: 1000, expectedYtd: 3500, difference: -2500, revenueYtd: 100000,
  periodsElapsed: 10, nextBilling: '2026-11-01', error: null,
  period: 'ytd', periodFrom: '2026-01-01', periodTo: '2026-10-07', grossRevenue: 100000, calculatedFee: 3500, feeTier: 'percent', periodBillings: 10, ...over,
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
    getAmaAccounts: vi.fn(async () => ({ accounts: [{ code: '40500', title: 'Asset Management Fee Income' }, { code: '41000', title: 'Rental Income' }] })),
  },
  withFreshReads: vi.fn((fn) => fn()),
}));
vi.mock('./drill', () => ({ requestReportDrill: vi.fn() }));

import ManagementFeesTab, { calcTitle, feeText, periodOptions, validateAgreement } from './ManagementFeesTab';
import { api, withFreshReads } from '../../api';
import { requestReportDrill } from './drill';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getAmaSummary.mockImplementation(async () => summary);
});


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
describe('ManagementFeesTab', () => {
  it('renders the agreements with fees, figures and the next billing date', async () => {
    render(<ManagementFeesTab canEdit />);
    expect(screen.getByText('Management Fees')).toBeTruthy();
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

  it('has the standard table view: a value list narrows the agreements and the totals follow (10/23, item 01)', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    const total = () => screen.getByText('Total').closest('tr');
    // Both agreements: 3,500.00 + 3,500.00 calculated.
    expect(within(total()).getByText('7,000.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter Status by value' }));
    const list = await screen.findByRole('dialog', { name: 'Status values' });
    fireEvent.click(within(list).getByRole('checkbox', { name: /Pending Review/ }));
    expect(screen.queryByText('56000 MCD Services, Inc.')).toBeNull();
    expect(within(total()).queryByText('7,000.00')).toBeNull();
    expect(within(total()).getAllByText('3,500.00')).toHaveLength(2);     // Calculated Fee and Expected YTD of the one left
    expect(screen.getByText('Unsaved')).toBeTruthy();
    // Hide Fee from its heading menu.
    fireEvent.click(screen.getByRole('button', { name: /^Fee - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Fee column' })).getByRole('menuitem', { name: /Hide Column/ }));
    expect(screen.queryByRole('columnheader', { name: 'Fee' })).toBeNull();
    // The row's buttons stay last and are not a column to filter.
    expect(screen.queryByRole('button', { name: 'Filter Actions by value' })).toBeNull();
  });

  it('opens the ledger lines behind Billed YTD', async () => {
    render(<ManagementFeesTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: /Ledger lines behind the billed fee/ }));
    expect(requestReportDrill).toHaveBeenCalledWith(expect.objectContaining({ account: '40500', entity: '90000', from: '2026-01-01', to: '2026-10-07' }));
  });

  it('validates inline and saves a new agreement', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    fireEvent.click(screen.getByRole('button', { name: /Add Agreement/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Agreement' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    expect(within(dialog).getByText('Pick the managed entity.')).toBeTruthy();
    expect(within(dialog).getByText('Pick the start date.')).toBeTruthy();
    expect(api.createAmaAgreement).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Managed Entity' }));
    fireEvent.click(await screen.findByText(/Greens Escondido, LLC\./, { selector: '[role="option"] *, [role="option"]' }));
    fireEvent.change(within(dialog).getByLabelText('Fee Basis'), { target: { value: 'percent_revenue' } });
    fireEvent.change(within(dialog).getByLabelText('Fee Rate %'), { target: { value: '3.5' } });
    fireEvent.change(within(dialog).getByLabelText('Start Date'), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('Agreement Link'), { target: { value: 'https://example.com/a.pdf' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    await waitFor(() => expect(api.createAmaAgreement).toHaveBeenCalledWith(expect.objectContaining({
      entityCode: '15000', feeBasis: 'percent_revenue', feeRate: 3.5, flatAmount: null, startDate: '2026-01-01', agreementUrl: 'https://example.com/a.pdf',
    })));
  });

  it('removes an agreement only after Remove is confirmed in place', async () => {
    render(<ManagementFeesTab canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the agreement of 15000 Greens Escondido, LLC.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.deleteAmaAgreement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the agreement of 15000 Greens Escondido, LLC.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteAmaAgreement).toHaveBeenCalledWith('A1'));
  });

  it('hides editing from viewers and shows the empty state', async () => {
    api.getAmaSummary.mockImplementation(async () => ({ year: 2026, asOf: '2026-10-07', rows: [] }));
    render(<ManagementFeesTab />);
    expect(await screen.findByText('No asset management agreements yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add Agreement/ })).toBeNull();
  });

  it('shows a plain error with Try Again', async () => {
    api.getAmaSummary.mockImplementation(async () => { throw new Error('Server error'); });
    render(<ManagementFeesTab canEdit />);
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
    // CR-03: Percent or Flat needs the percent, the flat fee and the threshold.
    const tier = { ...ok, feeBasis: 'percent_or_flat', feeRate: 3, flatAmount: 3000, thresholdAmount: 100000 };
    expect(validateAgreement(tier)).toEqual({});
    expect(Object.keys(validateAgreement({ ...tier, feeRate: '', flatAmount: null, thresholdAmount: null })).sort()).toEqual(['feeRate', 'flatAmount', 'thresholdAmount']);
    expect(feeText(tier)).toBe('3.00% of gross over $100,000.00, else $3,000.00 a year');
  });

  // ── CR-03 ────────────────────────────────────────────────────────────────
  it('shows the period gross revenue and the calculated fee, with the side of the threshold', async () => {
    api.getAmaSummary.mockImplementation(async () => ({
      ...summary,
      rows: [row({ feeBasis: 'percent_or_flat', feeRate: 3, flatAmount: 3000, thresholdAmount: 100000, grossRevenue: 30000, calculatedFee: 750, feeTier: 'flat',
        testGross: 30000, thresholdUsed: 100000, thresholdBasisUsed: 'annual', periodBillings: 3 })],
    }));
    render(<ManagementFeesTab canEdit />);
    const tr = (await screen.findByText('15000 Greens Escondido, LLC.')).closest('tr');
    expect(within(tr).getByText('30,000.00')).toBeTruthy();
    const fee = within(tr).getByText('750.00').closest('td');
    expect(within(fee).getByText('Flat')).toBeTruthy();
    expect(fee.getAttribute('title')).toMatch(/Annual Gross 30,000.00 is not above the threshold 100,000.00/);
    expect(screen.getByRole('columnheader', { name: 'Gross Revenue' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Calculated Fee' })).toBeTruthy();
  });

  it('reads the summary for the picked period', async () => {
    render(<ManagementFeesTab />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    const year = new Date().getFullYear();
    expect(api.getAmaSummary).toHaveBeenLastCalledWith(year, 'ytd');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'q1' } });
    await waitFor(() => expect(api.getAmaSummary).toHaveBeenLastCalledWith(year, 'q1'));
  });

  it('saves a Percent or Flat agreement with the threshold and a searched fee GL account', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    fireEvent.click(screen.getByRole('button', { name: /Add Agreement/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Agreement' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Managed Entity' }));
    fireEvent.click(await screen.findByText(/Greens Escondido, LLC\./, { selector: '[role="option"] *, [role="option"]' }));
    fireEvent.change(within(dialog).getByLabelText('Fee Basis'), { target: { value: 'percent_or_flat' } });
    // The operating agreement's figures are filled in (assumptions.js).
    expect(within(dialog).getByLabelText('Fee Rate %').value).toBe('3');
    expect(within(dialog).getByLabelText('Threshold Measured On')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Threshold Measured On'), { target: { value: 'period' } });
    fireEvent.change(within(dialog).getByLabelText('Start Date'), { target: { value: '2026-01-01' } });
    // Fee GL Account: search the ledger's accounts by title, pick one.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fee GL Account' }));
    fireEvent.change(await screen.findByPlaceholderText('Search account by name or GL code'), { target: { value: 'management' } });
    fireEvent.click(await screen.findByText('Asset Management Fee Income'));
    expect(within(dialog).getByRole('button', { name: 'Fee GL Account' }).textContent).toMatch(/40500 Asset Management Fee Income/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    await waitFor(() => expect(api.createAmaAgreement).toHaveBeenCalledWith(expect.objectContaining({
      entityCode: '15000', feeBasis: 'percent_or_flat', feeRate: 3, flatAmount: 3000, thresholdAmount: 100000, thresholdBasis: 'period', feeGlAccount: '40500',
    })));
  });

  it('takes a typed GL code that has no activity yet', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit the agreement of 15000 Greens Escondido, LLC.' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Agreement' });
    expect(within(dialog).getByRole('button', { name: 'Fee GL Account' }).textContent).toMatch(/40500/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fee GL Account' }));
    fireEvent.change(await screen.findByPlaceholderText('Search account by name or GL code'), { target: { value: '40999' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Use "40999"' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAmaAgreement).toHaveBeenCalledWith('A1', expect.objectContaining({ feeGlAccount: '40999', thresholdAmount: null })));
  });

  // ── CR-03 team answer (23 Oct): 3% of gross or $3,000/month, whichever is higher
  it('starts a new agreement on Greater Of with 3% and $3,000 a month, and saves it', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    fireEvent.click(screen.getByRole('button', { name: /Add Agreement/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Agreement' });
    expect(within(dialog).getByLabelText('Fee Basis').value).toBe('greater_of');
    expect(within(dialog).getByLabelText('Fee Rate %').value).toBe('3');
    expect(within(dialog).getByText('Monthly Minimum')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Managed Entity' }));
    fireEvent.click(await screen.findByText(/Greens Escondido, LLC\./, { selector: '[role="option"] *, [role="option"]' }));
    fireEvent.change(within(dialog).getByLabelText('Start Date'), { target: { value: '2026-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Agreement' }));
    await waitFor(() => expect(api.createAmaAgreement).toHaveBeenCalledWith(expect.objectContaining({
      entityCode: '15000', feeBasis: 'greater_of', feeRate: 3, flatAmount: 3000, thresholdAmount: null,
    })));
  });

  it('shows which rule applied on a Greater Of agreement', async () => {
    api.getAmaSummary.mockImplementation(async () => ({
      ...summary,
      rows: [row({ feeBasis: 'greater_of', feeRate: 3, flatAmount: 3000, grossRevenue: 350000, calculatedFee: 12000, feeTier: 'mixed',
        minimumUsed: 3000, minimumMonths: 1, percentMonths: 2, compareBy: 'month' })],
    }));
    render(<ManagementFeesTab canEdit />);
    const tr = (await screen.findByText('15000 Greens Escondido, LLC.')).closest('tr');
    expect(within(tr).getByText('3.00% of gross or $3,000.00/month, whichever is higher')).toBeTruthy();
    const fee = within(tr).getByText('12,000.00').closest('td');
    expect(within(fee).getByText('Mixed')).toBeTruthy();
    expect(fee.getAttribute('title')).toBe('Compared month by month: 3.00% of gross in 2 months, the $3,000.00 monthly minimum in 1 month');
    expect(calcTitle({ feeBasis: 'greater_of', feeRate: 3, calculatedFee: 3000, feeTier: 'minimum', minimumUsed: 3000, minimumMonths: 1 }))
      .toBe('the $3,000.00 monthly minimum was higher (1 month, compared month by month)');
    expect(validateAgreement({ entityCode: '1', feeBasis: 'greater_of', feeRate: 3, flatAmount: null, startDate: '2026-01-01' })).toEqual({ flatAmount: 'Type the monthly minimum.' });
  });

  it('lists only the periods that have started', () => {
    const opts = periodOptions(2026, new Date(2026, 9, 23)).map(([k]) => k);
    expect(opts).toEqual(['ytd', 'q1', 'q2', 'q3', 'q4', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10']);
    expect(periodOptions(2025, new Date(2026, 0, 5))).toHaveLength(1 + 4 + 12);
    expect(periodOptions(2025, new Date(2026, 0, 5))[0][1]).toBe('Full Year');
    expect(calcTitle({ calculatedFee: 0, feeTier: null })).toBe('Not in force in this period');
  });
});

// 10/23 Accounting meeting, items 05 and 13.
describe('ManagementFeesTab, Sync and the scroll box', () => {
  it('Sync reads the agreements again, fresh, and leaves the filter and an open dialog as they were', async () => {
    render(<ManagementFeesTab canEdit />);
    await screen.findByText('15000 Greens Escondido, LLC.');
    expect(screen.getByTestId('mgmt-fees-box').className).toContain('acct-scroll-box');
    fireEvent.click(screen.getByRole('button', { name: 'Filter agreements' }));   // item 02: an icon until used
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter agreements' }), { target: { value: 'Escondido' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Agreement/ }));
    await screen.findByRole('dialog', { name: 'Add Agreement' });
    let release;
    api.getAmaSummary.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ...summary, rows: [row({ billedYtd: 2000 })] }); }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(withFreshReads).toHaveBeenCalledTimes(1);
    // While it reads, the rows on screen stay (no skeleton), and so does the dialog.
    expect(screen.getByText('15000 Greens Escondido, LLC.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add Agreement' })).toBeTruthy();
    release();
    expect((await screen.findAllByText('2,000.00')).length).toBeGreaterThan(0);
    expect(api.getAmaSummary).toHaveBeenCalledTimes(2);
    expect(api.getAccountingLocations).toHaveBeenCalledTimes(1);   // only this table was read again
    expect(screen.getByLabelText('Filter agreements').value).toBe('Escondido');
    expect(screen.getByRole('dialog', { name: 'Add Agreement' })).toBeTruthy();
  });
});
