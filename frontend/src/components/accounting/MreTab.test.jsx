import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
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

import MreTab, { MreFromLedger, dueInMonth, frequencyLabel, mreColumnFilter, mreFilterColumns, mreTable, steadyProgress, visibleRows } from './MreTab';
import { linesCsv } from './linesExport';
import { api } from '../../api';
import { downloadBlob } from './reportModel';
import fs from 'node:fs';
import path from 'node:path';
import { resetAccountingPrefs } from './prefs';

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getMreProposals.mockImplementation(async () => proposals);
});


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
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
    fireEvent.click(screen.getByRole('button', { name: 'Search a vendor' }));   // item 02: an icon until used
    fireEvent.change(screen.getByRole('textbox', { name: 'Search a vendor' }), { target: { value: 'micro' } });
    expect(screen.queryByText('San Diego Gas & Electric')).toBeNull();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search a vendor'), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'utilities' } });
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
    expect(text).toContain('Vendor No.,Vendor,Entity,Category,Frequency,Expected,Jan');
    expect(text).toContain('V-SDGE,San Diego Gas & Electric,"Greens Escondido, LLC. (15000)",Utilities,Monthly,410');
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

  // Oct 7 (Charmi: "stuck at 133 of 142 entities" for 5+ minutes).
  it('shows what was read, lists what was not, and retries just those', async () => {
    const partial = { ...proposals, entitiesScanned: 142, entitiesRead: 133, failed: Array.from({ length: 9 }, (_v, i) => ({ code: `9${i}000`, name: `Big Entity ${i + 1}`, reason: 'took too long to read' })) };
    const rest = { ...proposals, entitiesScanned: 9, entitiesRead: 9, failed: [], proposals: [{ ...proposals.proposals[1], entityCode: '90000', entityName: 'Big Entity 1', vendorId: 'V-PGE', vendorName: 'PG&E' }] };
    api.getMreProposals.mockImplementation(async (_min, entities = []) => (entities.length && entities[0] === '90000' ? rest : partial));
    render(<MreFromLedger pollMs={20} onClose={() => {}} onCreated={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Add recurring expenses from the ledger/ });
    expect(await within(dialog).findByText('Read 133 of 142 entities - 9 could not be read.')).toBeTruthy();
    expect(within(dialog).getByText('State Farm')).toBeTruthy();                  // what was read is usable now
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry 9 Entities' }));
    await within(dialog).findByText('PG&E');
    expect(api.getMreProposals).toHaveBeenLastCalledWith(3, partial.failed.map((f) => f.code));
    expect(within(dialog).getByText('Read all 142 entities.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add 2 Expenses' })).toBeTruthy();
  });

  // Oct 14 (Charmi: "Set up ledger option needs to be taken out from MRE").
  it('offers + Add with Manual only', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const menu = screen.getByRole('menu', { name: 'Add a recurring expense' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.querySelector('span span').textContent)).toEqual(['Manual']);
  });

  // Oct 14 (Urmi: "the number keeps reducing back").
  it('never shows the scan going backward', async () => {
    const answers = [{ scanning: true, done: 58, total: 142 }, { scanning: true, done: 40, total: 142 }, proposals];
    let n = 0;
    api.getMreProposals.mockImplementation(async () => answers[Math.min(n++, answers.length - 1)]);
    render(<MreFromLedger pollMs={60} onClose={() => {}} onCreated={() => {}} />);
    await screen.findByText('Reading the ledger... 58 of 142 entities');
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Reading the ledger... 40 of 142 entities')).toBeNull();
    await screen.findByText('State Farm');
    expect(steadyProgress({ scanning: true, done: 58, total: 142 }, { scanning: true, done: 40, total: 142 }).done).toBe(58);
    expect(steadyProgress({ scanning: true, done: 58, total: 142 }, { scanning: true, done: 3, total: 9 }).done).toBe(3);   // another run
    expect(steadyProgress(null, { scanning: true, done: 3, total: 9 }).done).toBe(3);
  });
});

// Oct 14 (Charmi, Urmi, Priyanka, Neil): the Add Recurring Expense dialog.
describe('MreTab Oct 14 feedback', () => {
  const openAdd = async () => {
    api.getAccountingDimensionValues.mockImplementation(async () => ({ values: [{ code: 'V-100', name: 'Acme Power' }, { code: 'V-200', name: 'County Tax Collector' }] }));
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Manual/ }));
    return screen.getByRole('dialog', { name: 'Add recurring expense' });
  };

  it('picks the vendor from a dropdown with the number on the left, or keeps free text', async () => {
    const dialog = await openAdd();
    const box = within(dialog).getByRole('combobox', { name: 'Vendor' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'tax' } });
    const opt = await screen.findByRole('option', { name: /County Tax Collector/ });
    expect(opt.textContent.indexOf('V-200')).toBeLessThan(opt.textContent.indexOf('County Tax Collector'));
    expect(screen.queryByRole('option', { name: /Acme Power/ })).toBeNull();
    fireEvent.mouseDown(opt);
    expect(box.value).toBe('V-200 - County Tax Collector');
    fireEvent.change(box, { target: { value: 'Brand New Vendor' } });
    expect(box.value).toBe('Brand New Vendor');
  });

  it('has the new categories, Semi-Annual and Custom every N months, Variance %, and the vendor details', async () => {
    const dialog = await openAdd();
    const cats = [...within(dialog).getByLabelText('Category').querySelectorAll('option')].map((o) => o.textContent);
    for (const c of ['Mortgage', 'Dues & Subscriptions', 'Property Tax', 'Advertising', 'Auto Registration', 'State Tax']) expect(cats).toContain(c);
    const freqs = [...within(dialog).getByLabelText('Frequency').querySelectorAll('option')].map((o) => o.textContent);
    expect(freqs).toEqual(['Monthly', 'Quarterly', 'Semi-Annual', 'Annual', 'Custom']);
    expect([...within(dialog).getByLabelText('Variance').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['0%', '5%', '10%', '15%', '20%', '25%', '30%', '35%', '40%', '45%', '50%']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Entity' }));
    fireEvent.click(screen.getByRole('option', { name: /MCD Services/ }));
    const box = within(dialog).getByRole('combobox', { name: 'Vendor' });
    fireEvent.focus(box);
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Acme Power/ }));
    fireEvent.change(within(dialog).getByLabelText('Expense Accounts'), { target: { value: '62100' } });
    fireEvent.change(within(dialog).getByLabelText('Category'), { target: { value: 'property_tax' } });
    fireEvent.change(within(dialog).getByLabelText('Start'), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('Frequency'), { target: { value: 'custom' } });
    fireEvent.change(within(dialog).getByLabelText('Every (Months)'), { target: { value: '4' } });
    expect(within(dialog).getByText(/Due in \d{4}: Jan, May, Sep\./)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Variance'), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('Account Number'), { target: { value: 'ACCT-0042' } });
    fireEvent.change(within(dialog).getByLabelText('Account Details'), { target: { value: 'Parcel 12-345' } });
    fireEvent.change(within(dialog).getByLabelText('Contact Information'), { target: { value: 'Jane Doe, 800-555-0100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createMreLine).toHaveBeenCalled());
    expect(api.createMreLine.mock.calls[0][0]).toMatchObject({
      entityCode: '56000', vendorId: 'V-100', vendorName: 'Acme Power', expenseAccounts: ['62100'], category: 'property_tax',
      frequency: 'custom', frequencyMonths: 4, variancePct: 10, accountNumber: 'ACCT-0042', accountDetails: 'Parcel 12-345', contactInfo: 'Jane Doe, 800-555-0100',
    });
  });

  it('works out the months a line falls due, frontend like the API', () => {
    const due = (l) => [...Array(12).keys()].map((i) => i + 1).filter((m) => dueInMonth({ status: 'active', endDate: '', ...l }, 2026, m));
    expect(due({ frequency: 'semi_annual', startDate: '2025-03-01' })).toEqual([3, 9]);
    expect(due({ frequency: 'custom', frequencyMonths: 2, startDate: '2026-01-10' })).toEqual([1, 3, 5, 7, 9, 11]);
    expect(due({ frequency: 'quarterly', startDate: '2026-02-15' })).toEqual([2, 5, 8, 11]);
    expect(frequencyLabel({ frequency: 'custom', frequencyMonths: 2 })).toBe('Every 2 Months');
    expect(frequencyLabel({ frequency: 'semi_annual' })).toBe('Semi-Annual');
  });

  it('shows the vendor number on the left in the grid and the optional columns under Customize', async () => {
    api.getMreGrid.mockImplementationOnce(async () => ({ ...grid, rows: [{ ...grid.rows[0], line: { ...grid.rows[0].line, accountNumber: 'ACCT-9', contactInfo: 'Billing, 800-411-7343', variancePct: 5 } }, ...grid.rows.slice(1)] }));
    render(<MreTab canEdit />);
    const vendor = await screen.findByText('San Diego Gas & Electric');
    expect(vendor.textContent.indexOf('V-SDGE')).toBe(0);
    expect(screen.queryByRole('columnheader', { name: 'Account Number' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByLabelText(/Show Account Number/));
    fireEvent.click(screen.getByLabelText(/Show Contact Information/));
    expect(await screen.findByRole('columnheader', { name: 'Account Number' })).toBeTruthy();
    const row = vendor.closest('tr');
    expect(within(row).getByText('ACCT-9')).toBeTruthy();
    expect(within(row).getByText('Billing, 800-411-7343')).toBeTruthy();
  });
});

// Oct 7 (items 9, 12, 21, 32, 33): the module's shared controls on MRE.
describe('MreTab shared controls', () => {
  it('Customize has Row Density, Rows per Page and the MRE toggles; the pager keeps Total Paid over every line', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    const btn = screen.getByRole('button', { name: /Customize/ });
    expect(btn.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.getByRole('group', { name: 'Row Density' })).toBeTruthy();
    expect(screen.getByLabelText(/Show Ended/)).toBeTruthy();
    expect(screen.getByLabelText(/Show Zero Balances/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Rows per Page' })).getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '1' } });
    await screen.findByText(/Page 1 of 2/);
    expect(screen.queryByText('Microsoft')).toBeNull();
    const grand = screen.getByText('Total Paid').closest('tr');
    expect(within(grand).getByText('3,379.00')).toBeTruthy();         // 3,280 + 99: both lines, not the page
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Microsoft')).toBeTruthy();
  });

  it('has a resize handle on the grid columns', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    for (const name of ['Vendor', 'Entity', 'Category', 'Jan', 'Total', 'Notes']) {
      expect(screen.getByRole('separator', { name: `Resize the ${name} column` })).toBeTruthy();
    }
  });

  it('the entity on a line is the module picker, found by its number', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Manual/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add recurring expense' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Entity' }));
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '56000' } });
    const opt = screen.getByRole('option', { name: /MCD Services/ });
    expect(opt.textContent.indexOf('56000')).toBeLessThan(opt.textContent.indexOf('MCD Services'));
    fireEvent.click(opt);
    expect(within(dialog).getByRole('button', { name: 'Entity' }).textContent).toContain('MCD Services, Inc. (56000)');
  });

  it('a paid month opens the ledger lines behind it, each entry opening the entry', async () => {
    api.searchAccountingLedger = vi.fn(async () => ({ rows: [{ entry_id: 'e-1', entry_no: 'AP-2001', entry_date: '2026-01-15', account_no: '62100', description: 'SDGE January', debit: 410, credit: 0 }] }));
    api.getAccountingEntry = vi.fn(async () => ({ entry: { entry_no: 'AP-2001' }, lines: [], intacct: [] }));
    render(<MreTab canEdit />);
    const row = (await screen.findByText('San Diego Gas & Electric')).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Ledger lines for Jan 2026' }));
    const dialog = screen.getByRole('dialog', { name: 'San Diego Gas & Electric, Jan 2026' });
    expect(api.searchAccountingLedger).toHaveBeenCalledWith({ account: '62100', party_kind: 'vendor', party: 'V-SDGE', location: '15000', from: '2026-01-01', to: '2026-01-31', limit: 100 });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'AP-2001' }));
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalledWith('e-1'));
    // The year's Total drills the same way.
    expect(within(row).getByRole('button', { name: /Ledger lines behind San Diego Gas & Electric's total for 2026/ })).toBeTruthy();
  });
});

// Oct 23 (Charmi, Teams): a filter box under every MRE heading, as on AMA.
describe('MreTab column filters', () => {
  it('text boxes hold the words typed, amount boxes compare, and they stack', () => {
    const rows = grid.rows;
    const cols = mreFilterColumns();
    const ids = (typed) => mreColumnFilter(rows, typed, cols).map((r) => r.line.id);
    expect(ids({})).toEqual(['L1', 'L2', 'L3']);
    expect(ids({ vendor: 'v-msft' })).toEqual(['L2']);
    expect(ids({ vendor: 'gas electric' })).toEqual(['L1']);
    expect(ids({ entity: '15000' })).toEqual(['L1', 'L3']);
    expect(ids({ entity: 'escondido', category: 'util' })).toEqual(['L1', 'L3']);
    expect(ids({ entity: 'escondido', expected: { op: '>', a: '400' } })).toEqual(['L1', 'L3']);
    expect(ids({ entity: 'escondido', total: { op: '>', a: '100' } })).toEqual(['L1']);
    expect(ids({ expected: { op: 'between', a: '50', b: '100' } })).toEqual(['L2']);
    expect(ids({ expected: { op: '<', a: '100' }, vendor: 'sdge' })).toEqual([]);
    expect(ids({ m1: { op: '=', a: '200' } })).toEqual(['L1']);
    // A month outside the period shown, or an optional column turned off, is ignored.
    expect(mreColumnFilter(rows, { m1: { op: '=', a: '999' } }, mreFilterColumns([], [9, 11])).length).toBe(3);
    expect(mreColumnFilter(rows, { accountNumber: 'zzz' }, cols).length).toBe(3);
    expect(mreColumnFilter([{ ...rows[0], line: { ...rows[0].line, accountNumber: 'AC-77' } }, rows[1]], { accountNumber: 'ac-77' }, mreFilterColumns(['accountNumber'])).length).toBe(1);
  });

  it('a box under each heading narrows the grid with the vendor search and category, and the export follows', async () => {
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    for (const l of ['Vendor', 'Entity', 'Category', 'Notes']) expect(screen.getByRole('textbox', { name: `Filter ${l}` })).toBeTruthy();
    for (const l of ['Expected', 'Jan', 'Total', 'Balance']) expect(screen.getByRole('combobox', { name: `Operator for ${l}` })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Entity' }), { target: { value: 'mcd' } });
    expect(screen.queryByText('San Diego Gas & Electric')).toBeNull();
    expect(screen.getByText('Microsoft')).toBeTruthy();
    // With the category: nothing left, the boxes stay so they can be cleared.
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'utilities' } });
    expect(screen.getByText('Nothing matches these column filters.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Entity' }), { target: { value: '' } });
    expect(screen.getByText('San Diego Gas & Electric')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: '' } });
    // An amount box: Expected > 100 leaves SDG&E only, with the vendor search on top.
    fireEvent.change(screen.getByRole('combobox', { name: 'Operator for Expected' }), { target: { value: '>' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Expected' }), { target: { value: '100' } });
    expect(screen.queryByText('Microsoft')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search a vendor' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search a vendor' }), { target: { value: 'micro' } });
    expect(screen.getByText('Nothing matches these column filters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search a vendor'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const file = downloadBlob.mock.calls[0][1];
    const text = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result)); fr.readAsText(file); });
    expect(text).toContain('San Diego Gas & Electric');
    expect(text).not.toContain('Microsoft');
    expect(api.setMreNotes).not.toHaveBeenCalled();
  });
});

// 10/23 meeting, item 01: the standard table view on the grid.
describe('MreTab standard table view', () => {
  it('a value list, a hidden column and a moved column: the grid, its boxes and the export follow the view', async () => {
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: 'Filter Vendor by value' }));
    const list = await screen.findByRole('dialog', { name: 'Vendor values' });
    fireEvent.click(within(list).getByRole('checkbox', { name: /Microsoft/ }));
    expect(screen.queryByText('Microsoft')).toBeNull();
    // Hide Notes, move Category left of Entity: the filter boxes move with their headings.
    fireEvent.click(screen.getByRole('button', { name: /^Notes - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Notes column' })).getByRole('menuitem', { name: /Hide Column/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Category - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Category column' })).getByRole('menuitem', { name: /Move Left/ }));
    const table = screen.getByRole('table', { name: /Recurring expenses/ });
    const heads = within(table.querySelector('thead tr')).getAllByRole('columnheader').map((h) => h.getAttribute('aria-label'));
    expect(heads.slice(0, 3)).toEqual(['Vendor', 'Category', 'Entity']);
    expect(heads).not.toContain('Notes');
    const boxes = table.querySelectorAll('.acct-filter-row td');
    expect(boxes[1].querySelector('input').getAttribute('aria-label')).toBe('Filter Category');
    // The Vendor column cannot move or hide: it stays pinned first.
    fireEvent.click(screen.getByRole('button', { name: /^Vendor - column menu/ }));
    const menu = await screen.findByRole('menu', { name: 'Vendor column' });
    expect(within(menu).queryByRole('menuitem', { name: /Hide Column/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const file = downloadBlob.mock.calls[0][1];
    const text = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result)); fr.readAsText(file); });
    const lines = text.replace(/^\s+/, '').split('\r\n');
    expect(lines[0].startsWith('Vendor No.,Vendor,Status,Category,Frequency,Entity,Expected,Jan')).toBe(true);
    expect(lines[0]).not.toContain('Notes');
    expect(text).toContain('San Diego Gas & Electric');
    expect(text).not.toContain('Microsoft');
  });
});

// Oct 23 (Viral, Charmi): the headings and filter boxes stick as one block,
// and the pinned Vendor cell stays solid while the months scroll under it.
describe('MreTab sticky header block', () => {
  it('keeps the headings and the filter boxes in one sticky head, the Vendor heading pinned left', async () => {
    render(<MreTab />);
    await screen.findByText('San Diego Gas & Electric');
    const table = screen.getByRole('table', { name: /Recurring expenses/ });
    expect(table.classList.contains('mre-grid')).toBe(true);
    const head = table.querySelector('thead');
    const vendorHead = within(head).getByRole('columnheader', { name: 'Vendor' });
    expect(head.contains(screen.getByRole('textbox', { name: 'Filter Vendor' }))).toBe(true);
    expect(head.contains(screen.getByRole('combobox', { name: 'Operator for Jan' }))).toBe(true);
    expect(vendorHead.style.position).toBe('sticky');
    expect(vendorHead.style.left).toBe('0px');
    expect(table.querySelector('tbody td.acct-label').closest('tbody')).toBeTruthy();
  });

  it('the stylesheet makes the head one sticky block and paints the pinned Vendor cell over the card color', () => {
    const rule = (sel) => css.split('\n').find((l) => l.startsWith(sel)) || '';
    expect(rule('.acct-report.mre-grid thead {')).toMatch(/position: sticky; top: 0/);
    expect(rule('.acct-report.mre-grid thead th, .acct-report.mre-grid .acct-filter-row td {')).toMatch(/top: auto/);
    expect(rule('.acct-report.mre-grid tbody tr td.acct-label {')).toMatch(/background: var\(--bg-card\)/);
    const hover = css.slice(css.indexOf('.acct-report.mre-grid tbody tr:not(.acct-section):not(.acct-subtotal):not(.acct-grand):hover td.acct-label'));
    expect(hover.slice(0, hover.indexOf('}'))).toMatch(/linear-gradient\(var\(--wk-brand-tint, #e8ecfd\), var\(--wk-brand-tint, #e8ecfd\)\), var\(--bg-card\)/);
  });
});
