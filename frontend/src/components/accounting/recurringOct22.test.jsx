import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// MRI / MRE feedback of Oct 22: the legend as a filter at the top of MRI, a
// month settled by an overpayment elsewhere (Covered), Frequency on an MRI
// source, the Possibly Ended chip; MRE's period control, sortable headers,
// the saved line refreshed in place (one row read, never the whole grid) and
// the vendor's Egnyte folder.

vi.mock('../../tasks/components', () => ({
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

const Y = new Date().getFullYear();
const mk = (m) => `${Y}-${String(m).padStart(2, '0')}`;
const lease = (over = {}) => ({
  id: 'L1', propertyName: '47385 RCR, Temecula', region: '', tenancy: 'external', landlord: '', entityCode: '12014', incomeAccounts: ['41101'], customerId: 'C00497',
  tenantName: 'Santos Blancos', contactName: '', phone: '', email: '', mailingAddress: '', leaseStart: `${Y}-01-01`, leaseEnd: '', securityDeposit: 0, leaseTerms: '',
  lateFee: 0, dueDay: 1, graceDays: 5, status: 'active', notes: '', replacesId: '', frequency: 'monthly', frequencyMonths: 0, possiblyEnded: null,
  rates: [{ id: 'r1', startDate: `${Y}-01-01`, rent: 3500, cam: 0, other: 0, note: '' }], ...over,
});
const c = (m, status, received, extra = {}) => ({ month: mk(m), inForce: true, expected: 3500, received, balance: 3500 - received, status, adjustment: 0, note: '', lateFee: 0, ...extra });
const up = (from) => Array.from({ length: 12 - from + 1 }, (_v, i) => c(from + i, 'upcoming', 0));
const roll = {
  year: Y, asOf: `${Y}-10-22`,
  rows: [
    { lease: lease(), monthsBehind: 0, owed: 0, lateFees: 0, balanceToDate: -25,
      months: [c(1, 'paid', 3500), c(2, 'paid', 3500), c(3, 'covered', 0, { covered: 3500, coveredBy: [mk(5)] }), c(4, 'paid', 3500),
        c(5, 'paid', 7025, { applied: 3500, appliedTo: [mk(3)] }), ...up(6)] },
    { lease: lease({ id: 'L2', propertyName: '910 SECR - Ste 101', customerId: 'C00725', tenantName: 'Dr Azadeh Shams', frequency: 'semi_annual',
      possiblyEnded: { since: `${Y}-10-20`, lastPaid: `${Y}-01`, taskId: 't1' } }), monthsBehind: 1, owed: 3500, lateFees: 0, balanceToDate: 3500,
      months: [c(1, 'paid', 3500), c(2, 'none', 0, { expected: 0, balance: 0, offCycle: true }), c(3, 'short', 1000), ...up(4)] },
  ],
  totals: [], summary: { leases: 2, behind: 1 }, linked: [],
};

const line = (over = {}) => ({
  id: 'M1', entityCode: '15000', entityName: 'Greens Escondido, LLC.', vendorId: 'V-SDGE', vendorName: 'San Diego Gas & Electric', expenseAccounts: ['62100'],
  category: 'utilities', frequency: 'monthly', expectedAmount: 410, startDate: `${Y}-01-01`, endDate: '', status: 'active', notes: '', source: 'manual', egnyteFolder: '', egnyteUrl: null, possiblyEnded: null, ...over,
});
const gm = (paid) => paid.map((p, i) => ({ month: mk(i + 1), due: true, expected: 410, paid: p, status: i < 9 ? (p >= 410 ? 'paid' : p ? 'short' : 'missed') : 'upcoming' }));
const mrow = (l, paid) => {
  const months = gm(paid);
  const done = months.filter((x) => x.status !== 'upcoming');
  const e = done.reduce((s, x) => s + x.expected, 0); const p = done.reduce((s, x) => s + x.paid, 0);
  return { line: l, months, paidTotal: paid.reduce((s, x) => s + x, 0), expectedYear: 4920, expectedToDate: e, paidToDate: p, balance: e - p, monthsMissed: done.filter((x) => x.status === 'missed').length, unread: false, vendorInactive: false };
};
const grid = {
  year: Y, asOf: `${Y}-10-22`, totals: [], summary: { lines: 2, expectedToDate: 0, paidToDate: 0, balance: 0, missed: 0 },
  rows: [
    mrow(line(), [410, 410, 410, 410, 410, 410, 410, 410, 410, 0, 0, 0]),
    mrow(line({ id: 'M2', vendorId: 'V-ATT', vendorName: 'AT&T', category: 'software', entityCode: '56000', entityName: 'MCD Services, Inc.', possiblyEnded: { since: `${Y}-10-20`, lastPaid: `${Y}-05`, taskId: '' } }),
      [900, 900, 900, 900, 900, 0, 0, 0, 0, 0, 0, 0]),
  ],
};

vi.mock('../../api', () => ({
  api: {
    getLeasingRentRollFor: vi.fn(async () => roll),
    getLeasingCustomers: vi.fn(async () => ({ customers: [] })),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido, LLC.' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getAccountingBucketsFor: vi.fn(async () => ({ rows: [] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [] })),
    createLeasingLease: vi.fn(async (body) => ({ id: 'L9', ...body })),
    getMreGrid: vi.fn(async () => grid),
    getMreGridRows: vi.fn(async () => ({ rows: [] })),
    updateMreLine: vi.fn(async (id, body) => ({ ...line(), ...body, id })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    suggestMreEgnyteFolder: vi.fn(async () => ({ root: '/Shared/Vendors', suggestions: [{ path: '/Shared/Vendors/San Diego Gas and Electric', name: 'San Diego Gas and Electric', score: 1 }] })),
    getMreVendor: vi.fn(async () => ({ available: false })),
  },
}));

import LeasingTab, { coverText, rowInStates } from './LeasingTab';
import MreTab, { sortRows, spanFigures, withRow } from './MreTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } resetAccountingPrefs(); });

describe('MRI, Oct 22', () => {
  it('the legend is a filter at the top: rows with a month in the picked state', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('47385 RCR, Temecula');
    const filter = screen.getByRole('group', { name: 'Show rows with a month that is' });
    fireEvent.click(within(filter).getByRole('button', { name: /Short/ }));
    expect(screen.queryByText('47385 RCR, Temecula')).toBeNull();
    expect(screen.getByText('910 SECR - Ste 101')).toBeTruthy();
    fireEvent.click(within(filter).getByRole('button', { name: /Covered/ }));      // either state
    expect(screen.getByText('47385 RCR, Temecula')).toBeTruthy();
    fireEvent.click(within(filter).getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('910 SECR - Ste 101')).toBeTruthy();
  });

  it('a month settled by the May payment reads Covered with its marker; an off-cycle month is a dash', async () => {
    render(<LeasingTab canEdit />);
    const row = (await screen.findByText('47385 RCR, Temecula')).closest('tr');
    const mar = within(row).getByRole('button', { name: new RegExp(`Mar ${Y}: Covered`) });
    expect(mar.textContent).toBe('3,500c');
    expect(mar.getAttribute('aria-label')).toMatch(new RegExp(`3,500.00 covered by the May ${Y} payment`));
    expect(within(row).getByRole('button', { name: new RegExp(`May ${Y}: Paid.*applied to Mar ${Y}`) })).toBeTruthy();
    const semi = screen.getByText('910 SECR - Ste 101').closest('tr');
    expect(within(semi).getByRole('button', { name: new RegExp(`Feb ${Y}: Not Due This Month`) }).textContent).toBe('-');
    expect(within(semi).getByText('Semi-Annual')).toBeTruthy();
    expect(within(semi).getByTestId('possibly-ended')).toBeTruthy();
  });

  it('a new source picks its frequency, Custom every N months', async () => {
    render(<LeasingTab canEdit />);
    await screen.findByText('47385 RCR, Temecula');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New Lease/ }));
    const dialog = screen.getByRole('dialog', { name: 'New lease' });
    fireEvent.change(within(dialog).getByLabelText('Property or Space'), { target: { value: 'Unit 9' } });
    fireEvent.change(within(dialog).getByLabelText('Tenant Name'), { target: { value: 'New Tenant' } });
    fireEvent.change(within(dialog).getByLabelText('Lease Start'), { target: { value: `${Y}-01-01` } });
    expect([...within(dialog).getByLabelText('Frequency').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Monthly', 'Quarterly', 'Semi-Annual', 'Annual', 'Custom']);
    fireEvent.change(within(dialog).getByLabelText('Frequency'), { target: { value: 'custom' } });
    fireEvent.change(within(dialog).getByLabelText('Every (Months)'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createLeasingLease).toHaveBeenCalled());
    expect(api.createLeasingLease.mock.calls[0][0]).toMatchObject({ frequency: 'custom', frequencyMonths: 4, leaseStart: `${Y}-01-01` });
  });

  it('rowInStates and coverText', () => {
    expect(rowInStates(roll.rows[0], ['covered'], [0, 11])).toBe(true);
    expect(rowInStates(roll.rows[0], ['covered'], [3, 5])).toBe(false);       // March is not shown
    expect(rowInStates({ kind: 'account', months: [] }, ['paid'], [0, 11])).toBe(false);
    expect(coverText({})).toBe('');
  });
});

describe('MRE, Oct 22', () => {
  it('the period control narrows the months, and Total and Balance follow it', async () => {
    render(<MreTab canEdit />);
    const row = (await screen.findByText('San Diego Gas & Electric')).closest('tr');
    expect(within(row).getByText('3,690.00')).toBeTruthy();                   // the full year, the server's figure
    fireEvent.change(screen.getByRole('combobox', { name: 'Months' }), { target: { value: 'q1' } });
    expect(screen.queryByRole('columnheader', { name: 'Apr' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Mar' })).toBeTruthy();
    expect(within(screen.getByText('San Diego Gas & Electric').closest('tr')).getByText('1,230.00')).toBeTruthy();
  });

  it('sorts from the header (10/23 item 01: its menu), the other way with one click on the arrow, and remembers it', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    const names = () => screen.getAllByRole('row').map((r) => r.textContent).filter((t) => /AT&T|San Diego/.test(t)).map((t) => (t.includes('AT&T') ? 'ATT' : 'SDGE'));
    expect(names()).toEqual(['SDGE', 'ATT']);
    fireEvent.click(screen.getByRole('button', { name: /^Vendor - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Vendor column' })).getByRole('menuitemradio', { name: /Sort Ascending/ }));
    expect(names()).toEqual(['ATT', 'SDGE']);                 // by name: AT&T before San Diego
    fireEvent.click(screen.getByRole('button', { name: 'Sort Vendor descending' }));
    expect(names()).toEqual(['SDGE', 'ATT']);
    expect(screen.getByRole('columnheader', { name: 'Vendor' }).getAttribute('aria-sort')).toBe('descending');
    await waitFor(() => expect(api.saveAccountingPrefs).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.saveAccountingPrefs.mock.calls.at(-1)[0].tableViews.mre.draft.sort).toEqual({ col: 'vendor', dir: 'desc' });
  });

  it("keeps a header sort chosen before views existed as the person's default (prefs.mreSort)", async () => {
    localStorage.setItem('nexus-accounting-prefs', JSON.stringify({ mreSort: { key: 'vendor', dir: 'asc' } }));
    resetAccountingPrefs();
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    const names = () => screen.getAllByRole('row').map((r) => r.textContent).filter((t) => /AT&T|San Diego/.test(t)).map((t) => (t.includes('AT&T') ? 'ATT' : 'SDGE'));
    expect(names()).toEqual(['ATT', 'SDGE']);
    expect(screen.queryByText('Unsaved')).toBeNull();
  });

  it('the view filters the grid; Total Paid and the summary follow it (10/23 item 01)', async () => {
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'vendor' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 value' }), { target: { value: 'san diego' } });
    expect(screen.queryByText('AT&T')).toBeNull();
    const grand = screen.getByText('Total Paid').closest('tr');
    const sdge = screen.getByText('San Diego Gas & Electric').closest('tr');
    expect(grand.cells[grand.cells.length - 3].textContent).toBe(sdge.cells[sdge.cells.length - 3].textContent);   // Total Paid = that one line's total
    // The summary over the line left (the server's is for every line: 0.00 here).
    expect(screen.getByText('Paid to Date').querySelector('strong').textContent).toBe('3,690.00');
  });

  it('a saved line refreshes its own row - one row read, never the whole grid', async () => {
    const fresh = mrow(line({ vendorName: 'SDG&E', egnyteFolder: '/Shared/Vendors/San Diego Gas and Electric', egnyteUrl: 'https://x.egnyte.com/app/index.do#storage/files/1/Shared/Vendors/San%20Diego' }),
      [410, 410, 410, 410, 410, 410, 410, 410, 410, 0, 0, 0]);
    api.getMreGridRows.mockImplementationOnce(async () => ({ rows: [fresh] }));
    render(<MreTab canEdit />);
    await screen.findByText('San Diego Gas & Electric');
    expect(screen.getByText('AT&T').closest('tr').querySelector('[data-testid="possibly-ended"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit San Diego Gas & Electric' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit recurring expense' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Find Folder/ }));
    fireEvent.click(await within(dialog).findByRole('listitem'));
    expect(within(dialog).getByLabelText('Contract and Documents Folder (Egnyte)').value).toBe('/Shared/Vendors/San Diego Gas and Electric');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateMreLine).toHaveBeenCalled());
    expect(api.updateMreLine.mock.calls[0][1]).toMatchObject({ egnyteFolder: '/Shared/Vendors/San Diego Gas and Electric' });
    await waitFor(() => expect(api.getMreGridRows).toHaveBeenCalledWith(Y, ['M1']));
    expect(await screen.findByLabelText('Documents of SDG&E in Egnyte')).toBeTruthy();
    expect(api.getMreGrid).toHaveBeenCalledTimes(1);                          // the first load only
  });

  it('spanFigures, sortRows and withRow', () => {
    const [a, b] = grid.rows;
    expect(spanFigures(a, [0, 11])).toEqual({ paid: a.paidTotal, balance: a.balance });
    expect(spanFigures(b, [5, 8])).toEqual({ paid: 0, balance: 1640 });
    expect(sortRows([a, b], { key: 'total', dir: 'desc' }).map((r) => r.line.id)).toEqual(['M2', 'M1']);   // 4,500 over 3,690
    expect(sortRows([a, b], { key: 'balance', dir: 'desc' }).map((r) => r.line.id)).toEqual(['M1', 'M2']);   // 0 over (810)
    const one = withRow(grid, 'M2', null);
    expect(one.rows.map((r) => r.line.id)).toEqual(['M1']);
    expect(one.summary.balance).toBe(a.balance);
    expect(withRow(grid, 'M3', { ...a, line: { ...a.line, id: 'M3' } }).rows).toHaveLength(3);
  });
});
