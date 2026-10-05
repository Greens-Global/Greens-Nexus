import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Reporting -> MRE (Oct 6): the grid renders (a render smoke
// test - a crash here would blank the screen), months colored by status, the
// vendor / category filters and Customize > Show Ended, the Notes column
// edited in place, + Add for editors only, the vendor hover card, the CSV
// export, and From the Ledger polling the scan and adding the ticked rows.

const line = (over = {}) => ({
  id: 'L1', entityCode: '15000', entityName: 'Greens Escondido, LLC.', vendorId: 'V-SDGE', vendorName: 'San Diego Gas & Electric', expenseAccounts: ['62100'],
  category: 'utilities', frequency: 'monthly', expectedAmount: 410, startDate: '2026-01-01', endDate: '', status: 'active', notes: '', source: 'ledger', ...over,
});
const months = (statuses, paid) => statuses.map((status, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, due: status !== 'none', expected: status === 'none' ? 0 : 410, paid: paid[i] || 0, status }));
const S = ['paid', 'short', 'missed', 'over', 'paid', 'paid', 'paid', 'paid', 'paid', 'upcoming', 'upcoming', 'upcoming'];
const P = [410, 200, 0, 600, 410, 410, 410, 410, 410];
const grid = {
  year: 2026, asOf: '2026-10-06',
  rows: [
    { line: line(), months: months(S, P), paidTotal: 3280, expectedYear: 4920, expectedToDate: 3690, paidToDate: 3280, balance: 410, monthsMissed: 1, unread: false, vendorInactive: false },
    { line: line({ id: 'L2', vendorId: 'V-MSFT', vendorName: 'Microsoft', category: 'software', entityCode: '56000', entityName: 'MCD Services, Inc.', expectedAmount: 99 }), months: months(Array(12).fill('none'), []), paidTotal: 99, expectedYear: 0, expectedToDate: 0, paidToDate: 0, balance: 0, monthsMissed: 0, unread: false, vendorInactive: false },
    { line: line({ id: 'L3', vendorId: 'V-OLD', vendorName: 'Old Phone Co', status: 'ended', endDate: '2026-03-31' }), months: months(Array(12).fill('none'), []), paidTotal: 50, expectedYear: 0, expectedToDate: 0, paidToDate: 0, balance: 0, monthsMissed: 0, unread: false, vendorInactive: false },
  ],
  totals: Array.from({ length: 12 }, (_v, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, expected: 410, paid: P[i] || 0 })),
  summary: { lines: 2, expectedToDate: 3690, paidToDate: 3280, balance: 410, missed: 1 },
};
const proposals = {
  from: '2025-11-01', to: '2026-10-31', minCount: 3, entitiesScanned: 3, parentsSkipped: 1, historicalSkipped: 2, entitiesWithExpenses: 2, notes: [],
  proposals: [
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', vendorId: 'V-SDGE', vendorName: 'San Diego Gas & Electric', expenseAccounts: ['62100'], accountTitles: ['Utilities - Electric'], expectedAmount: 410, frequency: 'monthly', category: 'utilities', firstMonth: '2025-12', lastMonth: '2026-09', postedMonths: 10, stableMonths: 9, paid12: 4190, status: 'set_up', lineId: 'L1' },
    { entityCode: '15000', entityName: 'Greens Escondido, LLC.', vendorId: 'V-STATE', vendorName: 'State Farm', expenseAccounts: ['62500'], accountTitles: ['Insurance - Property'], expectedAmount: 1200, frequency: 'quarterly', category: 'insurance', firstMonth: '2025-12', lastMonth: '2026-09', postedMonths: 4, stableMonths: 4, paid12: 4800, status: 'new', lineId: null },
  ],
};

vi.mock('../../api', () => ({
  api: {
    getMreGrid: vi.fn(async () => grid),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    setMreNotes: vi.fn(async (id, notes) => ({ ...line(), id, notes })),
    getMreVendor: vi.fn(async () => ({ available: true, vendor: { id: 'V-SDGE', name: 'San Diego Gas & Electric', displayName: 'San Diego Gas & Electric', phone: '800-411-7343', email: 'billing@sdge.example', address: { line1: '8326 Century Park Ct', line2: '', city: 'San Diego', state: 'CA', zip: '92123', country: '' } } })),
    getMreProposals: vi.fn(async () => proposals),
    createMreFromLedger: vi.fn(async ({ items }) => ({ created: items.map((i) => ({ ...proposals.proposals.find((p) => p.vendorId === i.vendorId), lineId: 'L9' })), skipped: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    createMreLine: vi.fn(async (b) => ({ ...b, id: 'L7' })),
  },
}));
vi.mock('./reportModel', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import MreTab, { MreFromLedger, mreTable, visibleRows } from './MreTab';
import { linesCsv } from './linesExport';
import { api } from '../../api';
import { downloadBlob } from './reportModel';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getMreProposals.mockImplementation(async () => proposals);
});

describe('MreTab', () => {
  it('renders the grid with paid amounts colored against what was expected', async () => {
    render(<MreTab canEdit />);
    const vendor = await screen.findByText('San Diego Gas & Electric');
    const row = vendor.closest('tr');
    expect(within(row).getByLabelText(/Jan 2026 - Paid\. Expected 410\.00, paid 410\.00/).getAttribute('data-status')).toBe('paid');
    expect(within(row).getByLabelText(/Feb 2026 - Short/).getAttribute('data-status')).toBe('short');
    expect(within(row).getByLabelText(/Mar 2026 - Missed/).textContent).toBe('Missed');
    expect(within(row).getByLabelText(/Apr 2026 - Over/).getAttribute('data-status')).toBe('over');
    expect(within(row).getByLabelText(/Oct 2026 - Upcoming/)).toBeTruthy();
    expect(within(row).getByText('3,280.00')).toBeTruthy();       // the year's total paid
    expect(within(row).getByTitle('Expected less paid, to date').textContent).toBe('410.00');
    expect(screen.getByText('Total Paid')).toBeTruthy();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    // Ended lines wait for Customize > Show Ended.
    expect(screen.queryByText('Old Phone Co')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Ended/));
    expect(await screen.findByText('Old Phone Co')).toBeTruthy();
  });

  it('filters by vendor and category', async () => {
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.change(screen.getByLabelText('Search a vendor'), { target: { value: 'micro' } });
    expect(screen.queryByText('San Diego Gas & Electric')).toBeNull();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search a vendor'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'utilities' } });
    expect(screen.queryByText('Microsoft')).toBeNull();
    expect(screen.getByText('San Diego Gas & Electric')).toBeTruthy();
  });

  it('edits a note in place, and only editors get + Add', async () => {
    const { unmount } = render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    expect(screen.getByRole('button', { name: /Add/ })).toBeTruthy();
    const [notes] = screen.getAllByRole('button', { name: 'Notes for San Diego Gas & Electric' });
    fireEvent.click(notes);
    const input = screen.getByRole('textbox', { name: 'Notes for San Diego Gas & Electric' });
    fireEvent.change(input, { target: { value: 'Autopay on the 5th' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.setMreNotes).toHaveBeenCalledWith('L1', 'Autopay on the 5th'));
    expect(await screen.findByText('Autopay on the 5th')).toBeTruthy();
    unmount();
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Notes for/ })).toBeNull();
  });

  it('shows the vendor card on hover', async () => {
    render(<MreTab />);
    const vendor = await screen.findByText('San Diego Gas & Electric');
    fireEvent.mouseEnter(vendor);
    expect(await screen.findByText('800-411-7343', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText('billing@sdge.example')).toBeTruthy();
    expect(screen.getByText(/8326 Century Park Ct/)).toBeTruthy();
    expect(api.getMreVendor).toHaveBeenCalledWith('V-SDGE');
  });

  it('exports the grid as CSV', async () => {
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [name, file] = downloadBlob.mock.calls[0];
    expect(name).toBe('Monthly Recurring Expenses - 2026.csv');
    expect(file.type).toMatch(/text\/csv/);
    const text = linesCsv(mreTable(grid.rows.slice(0, 2), 2026, 'All entities'));
    expect(text).toContain('Vendor,Entity,Category,Frequency,Expected,Jan');
    expect(text).toContain('San Diego Gas & Electric,"Greens Escondido, LLC. (15000)",Utilities,Monthly,410');
    expect(text).toContain('Total Paid');
  });

  it('keeps rows with activity and hides the empty ones', () => {
    const empty = { ...grid.rows[1], paidTotal: 0 };
    expect(visibleRows([grid.rows[0], empty]).length).toBe(1);
    expect(visibleRows([grid.rows[0], empty], { showZero: true }).length).toBe(2);
    expect(visibleRows([{ ...grid.rows[0], vendorInactive: true }]).length).toBe(0);
    expect(visibleRows([{ ...grid.rows[0], vendorInactive: true }], { showInactive: true }).length).toBe(1);
  });
});

describe('MreFromLedger', () => {
  it('polls the scan, then adds the ticked vendors', async () => {
    let n = 0;
    api.getMreProposals.mockImplementation(async () => { n += 1; return n === 1 ? { scanning: true, done: 1, total: 3, startedAt: '2026-10-06T18:00:00Z' } : proposals; });
    const onCreated = vi.fn();
    render(<MreFromLedger pollMs={20} onClose={() => {}} onCreated={onCreated} />);
    const dialog = await screen.findByRole('dialog', { name: /Add recurring expenses from the ledger/ });
    await within(dialog).findByText('Reading the ledger... 1 of 3 entities');
    await within(dialog).findByText('State Farm');
    expect(within(dialog).getByText(/2 historical \(H\) entities not read/)).toBeTruthy();
    const existing = within(dialog).getByText('San Diego Gas & Electric').closest('tr');
    expect(within(existing).getByText('Set Up')).toBeTruthy();
    expect(within(existing).queryByRole('checkbox')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Category for State Farm'), { target: { value: 'other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 Expense' }));
    await within(dialog).findByText('1 recurring expense added.');
    expect(api.createMreFromLedger).toHaveBeenCalledWith({ items: [{ entityCode: '15000', vendorId: 'V-STATE', category: 'other' }], min: 3, entities: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onCreated).toHaveBeenCalled();
  });

  it('asks again with a different bar', async () => {
    render(<MreFromLedger onClose={() => {}} onCreated={() => {}} entities={['15000']} entityLabel="Greens Escondido, LLC. (15000)" />);
    await screen.findByText('State Farm');
    expect(api.getMreProposals).toHaveBeenLastCalledWith(3, ['15000']);
    fireEvent.change(screen.getByLabelText('Minimum months at a stable amount'), { target: { value: '6' } });
    await waitFor(() => expect(api.getMreProposals).toHaveBeenLastCalledWith(6, ['15000']));
  });
});
