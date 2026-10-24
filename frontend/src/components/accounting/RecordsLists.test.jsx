import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Records > General Ledger Accounts, Entities and a journal page (CR-12,
// Charmi's edited post and Neil, 23 Oct): read-only lists with search,
// resizable columns and Export; a journal page is that journal's lines.

vi.mock('../../api', () => ({
  api: {
    getAccountingAccounts: vi.fn(async () => ({ source: 'chart', accounts: [
      { account_no: '11000', title: 'Chase Checking', section: 'asset', account_type: 'balancesheet', normal_balance: 'debit', category: 'Cash', active: true },
      { account_no: '61000', title: 'Advertising', section: 'expense', account_type: 'incomestatement', normal_balance: 'debit', active: true },
      { account_no: '69999', title: 'Old Suspense', section: 'expense', active: false },
    ] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [
      { code: '12000', name: 'Greens Global, Inc.', parent_code: null, lines: 1200 },
      { code: '12019', name: 'GS Valley', parent_code: '12000', lines: 40 },
    ] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [{ symbol: 'PYRJ', title: 'Payroll Journal', kind: 'payroll' }] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [
      { entry_date: '2026-09-30', entry_no: '9001', entry_id: 'e1', journal: 'PYRJ', gl_code: '61905', account_name: 'Wages', description: 'Payroll 09/30/2026 - E-0185', debit: 1000, credit: 0 },
    ], total: 1, debit: 1000, credit: 0, facets: {} })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));

import { EntitiesTab, GlAccountsTab } from './RecordsLists';
import JournalTab from './JournalTab';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); });

describe('Records lists', () => {
  it('lists the chart of accounts, hides inactive ones until asked, and searches', async () => {
    render(<GlAccountsTab />);
    expect(await screen.findByText('Chase Checking')).toBeTruthy();
    expect(screen.queryByText('Old Suspense')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show inactive/ }));
    expect(screen.getByText('Old Suspense')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search General Ledger Accounts' }));   // item 02: an icon until used
    fireEvent.change(screen.getByRole('textbox', { name: 'Search General Ledger Accounts' }), { target: { value: 'advert' } });
    expect(screen.queryByText('Chase Checking')).toBeNull();
    expect(screen.getByText('Advertising')).toBeTruthy();
    expect(screen.getAllByRole('separator').length).toBeGreaterThan(3);   // resizable columns
  });

  it('says so when the chart is only the accounts posted to', async () => {
    api.getAccountingAccounts.mockResolvedValueOnce({ source: 'ledger', accounts: [{ account_no: '11000', title: 'Chase Checking', section: 'asset', active: true }] });
    render(<GlAccountsTab />);
    expect(await screen.findByText(/does not list its chart yet/)).toBeTruthy();
  });

  it('lists the entities with their parents', async () => {
    render(<EntitiesTab />);
    const row = (await screen.findByText('GS Valley')).closest('tr');
    expect(row.textContent).toContain('12000 Greens Global, Inc.');
  });
});

describe('a journal page', () => {
  it('reads that journal\'s lines for the period, with the search and filters', async () => {
    render(<JournalTab symbol="PYRJ" />);
    expect(await screen.findByText(/PYRJ - Payroll Journal/)).toBeTruthy();
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalled());
    const first = api.searchAccountingLedger.mock.calls[0][0];
    expect(first.journals).toBe('PYRJ');
    expect(first.from).toMatch(/^\d{4}-01-01$/);
    expect(await screen.findByText('Payroll 09/30/2026 - E-0185')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Back to Report/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search the PYRJ journal' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the PYRJ journal' }), { target: { value: 'E-0185' } });
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.at(-1)[0]).toMatchObject({ q: 'E-0185', journals: 'PYRJ' }));
  });
});
