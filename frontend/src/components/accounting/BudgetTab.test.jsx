import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Budget (Oct 2): the grid per entity and year, edits saved
// through the proxy, last year's actuals copied in, Budget vs Actual
// computed from the by-month buckets, and the "not available yet" state
// when the accounting app has not shipped the route.

const budget = { location: '13000', year: 2026, source: 'nexus', updatedAt: '2026-10-01T10:00:00Z', updatedBy: 'charmi@greensglobal.com',
  rows: [
    { accountNo: '41101', title: 'Rental Income', months: [1000, 1000, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { accountNo: '61101', title: 'Professional Fees - Accounting', months: [200, 200, 200, 200, 0, 0, 0, 0, 0, 0, 0, 0] },
  ] };
const buckets = { rows: [
  { account_no: '41101', title: 'Rental Income', section: 'revenue', bucket: '2026-01-01', debit: 0, credit: 1200 },
  { account_no: '41101', title: 'Rental Income', section: 'revenue', bucket: '2026-02-01', debit: 0, credit: 900 },
  { account_no: '61101', title: 'Professional Fees - Accounting', section: 'expense', bucket: '2026-01-01', debit: 250, credit: 0 },
  { account_no: '10100', title: 'Operating Bank', section: 'asset', bucket: '2026-01-01', debit: 5000, credit: 0 },
] };

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '13000', name: 'Darshana R. Kadakia MD Inc.' }, { code: '15000', name: 'Greens Escondido' }] })),
    getAccountingBudget: vi.fn(async () => budget),
    saveAccountingBudget: vi.fn(async (body) => ({ ...budget, rows: body.rows.map((r) => ({ ...r, title: budget.rows.find((x) => x.accountNo === r.accountNo)?.title || '' })) })),
    getAccountingBuckets: vi.fn(async () => buckets),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'charmi@greensglobal.com', name: 'Charmi Desai' }]),
  },
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true), prompt: vi.fn(async () => '') } }));

import BudgetTab from './BudgetTab';
import { api } from '../../api';
import { actualsByAccount, budgetVsActual, copyActuals, gridTotals } from './budgetModel';

beforeEach(() => { vi.clearAllMocks(); });

describe('budgetModel', () => {
  it('signs the actuals like the income statement and keeps P&L accounts only', () => {
    const a = actualsByAccount(buckets.rows, 2026);
    expect(a.get('41101').months.slice(0, 3)).toEqual([1200, 900, 0]);
    expect(a.get('61101').months[0]).toBe(250);
    expect(a.has('10100')).toBe(false);
  });
  it('copies the actuals over the grid and adds accounts the grid lacks', () => {
    const a = actualsByAccount([...buckets.rows, { account_no: '62000', title: 'Rent', section: 'expense', bucket: '2026-03-01', debit: 10, credit: 0 }], 2026);
    const rows = copyActuals(budget.rows, a);
    expect(rows.find((r) => r.accountNo === '41101').months[1]).toBe(900);
    expect(rows.find((r) => r.accountNo === '62000').months[2]).toBe(10);
    expect(gridTotals(budget.rows).total).toBe(3800);
  });
  it('computes Budget vs Actual year to date with the variance in dollars and percent', () => {
    const bva = budgetVsActual(budget.rows, actualsByAccount(buckets.rows, 2026), 2);
    const rent = bva.rows.find((r) => r.accountNo === '41101');
    expect(rent).toMatchObject({ actual: 2100, budget: 2000, variance: 100, pct: 5 });
    const fees = bva.rows.find((r) => r.accountNo === '61101');
    expect(fees).toMatchObject({ actual: 250, budget: 400, variance: -150, pct: -37.5 });
    expect(bva.totals).toMatchObject({ actual: 2350, budget: 2400, variance: -50 });
  });
});

describe('BudgetTab', () => {
  it('shows the grid for the entity and year with row and column totals', async () => {
    render(<BudgetTab canEdit />);
    expect(await screen.findByText('Rental Income')).toBeTruthy();
    expect(api.getAccountingBudget).toHaveBeenCalledWith('13000', new Date().getFullYear());
    const row = screen.getByText('Rental Income').closest('tr');
    expect(within(row).getByText('3,000.00')).toBeTruthy();
    expect(screen.getByText('Saved in Nexus', { exact: false })).toBeTruthy();
  });

  it('saves an edited cell through the proxy', async () => {
    render(<BudgetTab canEdit />);
    await screen.findByText('Rental Income');
    const cell = screen.getByLabelText('41101 Apr');
    fireEvent.change(cell, { target: { value: '5k' } });
    fireEvent.blur(cell);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.saveAccountingBudget).toHaveBeenCalled());
    const body = api.saveAccountingBudget.mock.calls[0][0];
    expect(body.rows.find((r) => r.accountNo === '41101').months[3]).toBe(5000);
    expect(body).toMatchObject({ location: '13000' });
  });

  it("copies last year's actuals into the grid", async () => {
    render(<BudgetTab canEdit />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: /Copy From Last Year's Actuals/ }));
    await waitFor(() => expect(api.getAccountingBuckets).toHaveBeenCalled());
    const y = new Date().getFullYear() - 1;
    expect(api.getAccountingBuckets.mock.calls[0][0]).toMatchObject({ from: `${y}-01-01`, to: `${y}-12-31`, by: 'month', location: '13000' });
  });

  it('shows Budget vs Actual through a month', async () => {
    render(<BudgetTab canEdit />);
    await screen.findByText('Rental Income');
    fireEvent.click(screen.getByRole('button', { name: 'Budget vs Actual' }));
    fireEvent.change(await screen.findByLabelText('Through month'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('Variance %')).toBeTruthy());
    const row = (await screen.findByText('Professional Fees - Accounting')).closest('tr');
    expect(within(row).getByText('(150.00)')).toBeTruthy();
    expect(within(row).getByText('(37.5%)')).toBeTruthy();
  });

  it('says so when the accounting app has not shipped budgets yet', async () => {
    api.getAccountingBudget.mockRejectedValueOnce(Object.assign(new Error('Not available yet'), { status: 501 }));
    render(<BudgetTab canEdit />);
    expect(await screen.findByText(/Not available yet - the accounting app needs its update/)).toBeTruthy();
  });
});
