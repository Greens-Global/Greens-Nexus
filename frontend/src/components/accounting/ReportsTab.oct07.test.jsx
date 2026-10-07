import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting > Reports on screen, Oct 7 batch (Charmi, Neil): the General
// Ledger with a vendor picked lists that vendor's lines only and counts
// them (31 / 20), its accounts fold under groups (22), pages keep a group
// whole (21), an entry number opens the entry (33), inactive accounts hide
// from Customize (34), amount filters take an operator (26d), the books come
// from the accounting app (35).

const tb = {
  org: 'Greens Global', generated_at: '2026-10-06', totals: { closing: 0 },
  rows: [
    { account_no: '10100', title: 'Chase Operating', class: 'Bank', class_rank: 1, group: 'Bank', active: true, opening: 1000, debit: 0, credit: 300, closing: 700 },
    { account_no: '11757', title: 'OSM - OP - 1629', class: 'Bank', class_rank: 1, group: 'Bank', active: false, opening: 19.14, debit: 0, credit: 0, closing: 19.14 },
    { account_no: '20100', title: 'Accounts Payable', class: 'Liabilities', class_rank: 4, group: 'Accounts Payable', active: true, opening: -500, debit: 300, credit: 0, closing: -200 },
  ],
};
const ln = (id, vendor, debit, credit) => ({ line_id: id, entry_id: `00000000-0000-0000-0000-00000000000${id}`, entry_no: `IA-${id}`, entry_date: `2026-0${id}-01`, description: `Payment ${id}`, vendor_id: vendor, debit, credit });
const LINES = { 10100: [ln(1, 'V05022', 0, 100), ln(2, 'V00236', 0, 150), ln(3, 'V05022', 0, 50)], 20100: [ln(4, 'V05022', 300, 0)] };

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '12000', name: 'Greens Global', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => ({ sections: [{ key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1500 }] }, { key: 'expense', accounts: [{ account_no: '61000', title: 'Repairs', amount: 400 }] }] })),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [] })),
    getAccountingCashPosition: vi.fn(async () => ({ accounts: [], total: 0 })),
    getAccountingTrialBalance: vi.fn(async () => tb),
    getAccountingBuckets: vi.fn(async () => ({ rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [{ code: 'V05022', name: 'Wunderlin Engineering' }, { code: 'V00236', name: 'Amerigas' }] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [{ symbol: 'APJ', title: 'Accounts Payable', kind: 'ap' }] })),
    getAccountingBooks: vi.fn(async () => ({ available: true, books: [{ key: 'accrual', label: 'Accrual' }, { key: 'cash', label: 'Cash' }, { key: 'fmv', label: 'Fair Market Journal', kind: 'user' }] })),
    readAccountingReport: vi.fn(async () => ({ sections: [] })),
    getAccountingFluxNotes: vi.fn(async () => ({ notes: [] })),
    saveAccountingFluxNote: vi.fn(async (b) => b),
    // The accounting service does NOT narrow the lines by vendor yet.
    searchAccountingLedger: vi.fn(async ({ account }) => ({ rows: LINES[account] || [], total: (LINES[account] || []).length })),
    getAccountingEntry: vi.fn(async () => ({ entry_no: 'IA-1', lines: [] })),
    getAccountingSavedReports: vi.fn(async () => []),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));
vi.mock('./EntryDetail', () => ({ default: ({ entryNo, onClose }) => <div role="dialog" aria-label="Journal Entry">Entry {entryNo}<button type="button" onClick={onClose}>Close</button></div> }));

import ReportsTab from './ReportsTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';
import { setUserBooks } from './reportModel';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); setUserBooks([]); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

async function openLedger() {
  render(<ReportsTab />);
  await screen.findByText('Rental Income');
  fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'general-ledger' } });
  await screen.findByText('Chase Operating');
}

describe('General Ledger on screen (Oct 7)', () => {
  it('lists only the picked vendor\'s lines and counts them', async () => {
    await openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /^Vendor/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Wunderlin/ }));
    await waitFor(() => expect(api.searchAccountingLedger.mock.calls.some((c) => c[0].vendor === 'V05022')).toBe(true));
    await waitFor(() => expect(screen.queryByText('IA-2')).toBeNull());
    expect(screen.getByText('IA-1')).toBeTruthy();
    expect(screen.getByText('IA-3')).toBeTruthy();
    expect(screen.getByLabelText('Summary').textContent).toContain('Lines 3');
  });

  it('folds accounts under groups, Collapse All / Expand All, and an entry number opens the entry', async () => {
    await openLedger();
    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Date / Account' })).toBeNull();
    expect(screen.getByText('Total Bank')).toBeTruthy();
    // Inactive 11757 is hidden by default; the footnote says so.
    expect(screen.queryByText('OSM - OP - 1629')).toBeNull();
    expect(screen.getByText('1 inactive account hidden (Customize). Totals include it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Bank' }));
    expect(screen.queryByText('Chase Operating')).toBeNull();
    expect(screen.getByText('Total Accounts Payable')).toBeTruthy();
    expect(screen.getByText('IA-4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }));
    expect(screen.getByText('Chase Operating')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }));
    expect(screen.queryByText('Chase Operating')).toBeNull();
    expect(screen.queryByText('IA-4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }));
    fireEvent.click(screen.getByRole('button', { name: 'IA-1' }));
    expect(await screen.findByRole('dialog', { name: 'Journal Entry' })).toBeTruthy();
    expect(screen.getByText('Entry IA-1')).toBeTruthy();
  });

  it('shows inactive accounts from Customize, and pages without splitting a group', async () => {
    await openLedger();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Inactive Accounts/));
    await screen.findByText('OSM - OP - 1629');
    fireEvent.click(screen.getByRole('button', { name: '50' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '4' } });
    const nav = await screen.findByRole('navigation', { name: 'Pages' });
    expect(nav.textContent).toMatch(/Page 1 of \d/);
    // Page 1 opens with the Bank heading and Chase's whole block.
    const body = screen.getAllByRole('row').map((r) => r.textContent);
    expect(body.some((t) => t.startsWith('Bank'))).toBe(true);
    // The grand total is under every page.
    expect(screen.getByText('Total - 3 accounts')).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Pages' }).textContent).toMatch(/Page 2 of/));
    expect(screen.getByText('Total - 3 accounts')).toBeTruthy();
  });
});

describe('the other Oct 7 controls', () => {
  it('filters an amount column with an operator', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const col = screen.getAllByRole('columnheader')[1].getAttribute('aria-label');
    fireEvent.change(screen.getByLabelText(`Operator for ${col}`), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText(`Filter ${col}`), { target: { value: '1000' } });
    await waitFor(() => expect(screen.queryByText('Repairs')).toBeNull());
    expect(screen.getByText('Rental Income')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(`Operator for ${col}`), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText(`Filter ${col}`), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(`Filter ${col} up to`), { target: { value: '500' } });
    await screen.findByText('Repairs');
    expect(screen.queryByText('Rental Income')).toBeNull();
  });

  it('offers the books the accounting app lists, and reads a user book', async () => {
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    const book = screen.getByLabelText('Book');
    await waitFor(() => expect([...book.options].map((o) => o.textContent)).toEqual(['Accrual', 'Cash', 'Fair Market Journal', 'Accrual and Cash']));
    fireEvent.change(book, { target: { value: 'fmv' } });
    await waitFor(() => expect(api.readAccountingReport).toHaveBeenCalledWith('pnl', expect.objectContaining({ book: 'fmv' })), { timeout: 2500 });
  });

  it('runs the Statement of Cash Flows and ties it to Cash Position', async () => {
    api.getAccountingCashPosition.mockImplementation(async (asof) => ({ accounts: [{ gl_code: '10100' }], total: asof < '2026-01-01' ? 5000 : 6100 }));
    api.getAccountingBalanceSheet.mockImplementation(async (asof) => ({ sections: [{ key: 'asset', accounts: [{ account_no: '10100', title: 'Chase Operating', amount: asof < '2026-01-01' ? 5000 : 6100 }] }] }));
    render(<ReportsTab />);
    await screen.findByText('Rental Income');
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'cash-flow' } });
    await screen.findByText('Cash Flows From Operating Activities');
    expect(screen.queryByLabelText('Book')).toBeNull();
    expect(screen.getByText(/^Cash at End of Period/).closest('tr').textContent).toContain('6,100.00');
    expect(screen.getByText('Net Change in Cash').closest('tr').textContent).toContain('1,100.00');
  });
});
