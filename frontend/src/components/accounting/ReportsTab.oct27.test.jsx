import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting > Reports on screen, 10/27 chat triage: Income Statement by Job
// (item 16), Spend by Vendor with its Vendors button (item 17), Schedule C
// (Draft) and its Line Mapping (item 18).

const PNL = {
  org: 'Greens Global', generated_at: '2026-10-27',
  sections: [
    { key: 'revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1500 }] },
    { key: 'expense', accounts: [{ account_no: '61000', title: 'Advertising', amount: 400 }, { account_no: '69000', title: 'Miscellaneous', amount: 25 }] },
  ],
};
const VENDOR_ROWS = { labels: { V05022: 'Wunderlin Engineering' }, rows: [{ account_no: '62100', title: 'Engineering Fees', section: 'expense', bucket: 'V05022', debit: 250, credit: 0 }] };

vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => PNL),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [] })),
    getAccountingBuckets: vi.fn(async ({ by }) => (by === 'vendor' ? VENDOR_ROWS : { rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [{ code: 'V05022', name: 'Wunderlin Engineering' }, { code: 'V01200', name: 'The Home Depot, Inc.' }] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [] })),
    getAccountingBooks: vi.fn(async () => ({ available: false })),
    getAccountingTaxLines: vi.fn(async () => ({ lines: [] })),
    saveAccountingTaxLines: vi.fn(async (b) => ({ lines: b.lines.map((l) => ({ ...l, entity: b.entity })) })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0 })),
    getAccountingSavedReports: vi.fn(async () => []),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));

import ReportsTab from './ReportsTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

describe('Reports, 10/27 triage', () => {
  it('Income Statement by Job opens split by Project-Job under its own title', async () => {
    render(<ReportsTab report="pnl" view="pnl-job" />);
    await waitFor(() => expect(api.getAccountingBuckets.mock.calls.some(([q]) => q.by === 'project')).toBe(true));
    expect(await screen.findByRole('heading', { name: /Income Statement by Job/ })).toBeTruthy();
    expect(screen.queryByText(/Profit & Loss/)).toBeNull();
  });

  it('Spend by Vendor: a Vendors button searched by name, and an account amount opens that vendor\'s lines', async () => {
    render(<ReportsTab report="vendor-spend" />);
    // Folded to one line per vendor (the summary names the largest one too).
    const group = await screen.findByRole('button', { name: 'Open V05022 Wunderlin Engineering' });
    expect(screen.getByRole('columnheader', { name: 'Vendor / Account' })).toBeTruthy();
    expect(screen.queryByText('Engineering Fees')).toBeNull();
    fireEvent.click(group);
    const row = (await screen.findByText('Engineering Fees')).closest('tr');
    fireEvent.click(within(row).getByTitle('See the lines behind this amount'));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalled());
    const q = api.searchAccountingLedger.mock.calls.at(-1)[0];
    expect(q).toMatchObject({ account: '62100', party_kind: 'vendor', party: 'V05022' });
  });

  it('Spend by Vendor\'s Vendors button finds a vendor by name and narrows the report to it', async () => {
    render(<ReportsTab report="vendor-spend" />);
    await screen.findByRole('button', { name: 'Open V05022 Wunderlin Engineering' });
    fireEvent.click(screen.getByRole('button', { name: 'Vendors' }));
    const panel = await screen.findByRole('dialog', { name: 'Vendors' });
    fireEvent.change(within(panel).getByLabelText('Search vendor by name or code'), { target: { value: 'depot home' } });
    const opts = within(panel).getAllByRole('option');
    expect(opts).toHaveLength(1);
    fireEvent.click(opts[0]);
    await waitFor(() => expect(api.getAccountingBuckets.mock.calls.some(([q]) => q.by === 'vendor' && q.dims?.vendor?.includes('V01200'))).toBe(true));
  });

  it('Schedule C: lines from the mapping, unmapped accounts for review, and Line Mapping saves in Nexus', async () => {
    render(<ReportsTab report="schedule-c" />);
    expect(await screen.findByText('Line 8 - Advertising')).toBeTruthy();
    expect(screen.getByText('Line 31 - Net profit or (loss)')).toBeTruthy();
    expect(screen.getAllByText(/Not Mapped - Pick a Line/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Schedule E, Form 4562/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Line Mapping \(1 Not Mapped\)/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Every entity/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Line for 69000 Miscellaneous'), { target: { value: '27b' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(api.saveAccountingTaxLines).toHaveBeenCalledWith({ form: 'schedule_c', entity: '', lines: [{ accountNo: '69000', line: '27b' }] }));
    // The report reads again with the new mapping.
    await waitFor(() => expect(api.getAccountingTaxLines.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
