// A job's Money (Neil, 11/03/2026, plan phase 4): who gets the tab and the
// Overview line, every posted figure drilling to its ledger lines with the
// job's Project-Job (and on to the journal entry), worked-out figures plain,
// resizable columns kept per person, the Books rows on Edit Job, Over Budget
// on the health row and the optional Job on a request. The rules live on the
// server (backend/test_construction_money.py); these pin what the screens do.
// Every figure below is made up for the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

let role = { manager: true };
vi.mock('../../api', () => ({ api: {
  getJobMoney: vi.fn(), getJobConnected: vi.fn(), searchAccountingLedger: vi.fn(), getAccountingEntry: vi.fn(),
  getAccountingPrefs: vi.fn(async () => ({ prefs: {} })), saveAccountingPrefs: vi.fn(async () => ({})),
  getConstructionMeta: vi.fn(async () => ({ aiEnabled: false, tags: [] })), getConstructionWeather: vi.fn(async () => ({ sites: [] })),
  weather: vi.fn(), getPeopleDirectory: vi.fn(async () => []), getTicketProperties: vi.fn(async () => ({ properties: [] })),
  getBookProjects: vi.fn(), mapJobBooks: vi.fn(), updateConstructionProject: vi.fn(), getSpendJobs: vi.fn(),
  getConstructionRegister: vi.fn(async () => []),
  // Round Three item 2 (11/11/2026): the client and cost codes.
  searchJobCustomers: vi.fn(), setJobClient: vi.fn(), getJobCostCodes: vi.fn(async () => ({ codes: [] })),
} }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => !!role[r], myEmail: 'pat.manager@example.com' }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn() } }));

const { api } = await import('../../api');
const { resetAccountingPrefs } = await import('../../components/accounting/prefs');
const { default: JobPage } = await import('./JobPage');
const { default: MoneyTab } = await import('./MoneyTab');
const { default: MoneyLine } = await import('./MoneyLine');
const { default: EditJobSheet } = await import('../EditJobSheet');
const { default: JobTagSelect } = await import('../../components/JobTagSelect');
const { jobTabs } = await import('../lib/job');
const { healthFacts } = await import('../lib/health');
const { spendTrack, usd } = await import('../lib/money');
const { parseConstructionSub } = await import('../lib/navigation');

const job = {
  id: 'j1', name: 'Sample Build', jobType: 'project', status: 'active', percentComplete: 40, canEdit: true,
  today: '2026-11-03', workerEmails: [], managerEmails: [], executiveEmails: [], names: {}, contractValue: 1000,
  health: { state: 'on_track', reasons: [], nextMilestone: null, overdueRfis: 0, lastLogDate: '', daysSinceLog: null, daysPastTarget: 0 },
};
const money = (over = {}) => ({
  allowed: true, jobId: 'j1', mapped: true, canMap: true, currency: 'USD', asOf: '2026-11-03',
  link: { project: 'PJ-1', entity: 'E1', entityName: 'Test Entity' },
  budget: { amount: 1000, contractValue: 1000, approvedChanges: 0, source: 'contract' },
  committed: { amount: 100, reimbursements: 1, otherCurrency: 0, purchaseRequests: 1 },
  changes: { rows: [{ id: 'c1', number: 'CO-1', title: 'Extra gate', state: 'pending', status: 'pending', amount: 50 }], approved: 0, pending: 50 },
  actual: {
    amount: 600, by: 'item',
    rows: [
      { key: 'CC-1', code: 'CC-1', label: 'Site Work', amount: 500, accounts: [{ account_no: '17100', title: 'Construction in Progress', section: 'asset', amount: 400 }, { account_no: '61000', title: 'Repairs', section: 'expense', amount: 100 }] },
      { key: '-', code: '', label: 'No Cost Code', amount: 100, accounts: [{ account_no: '61000', title: 'Repairs', section: 'expense', amount: 100 }] },
    ],
    left: [{ account_no: '20000', title: 'Accounts Payable', section: 'liability', amount: -600 }],
  },
  spend: {
    reimbursements: [
      { id: 'r1', item: 'Bolts', vendor: 'Hardware', amount: 100, currency: 'USD', requestedBy: 'Crew One', status: 'approver_approved', purchaseDate: '2026-11-01', paidOn: '', stage: 'requested' },
      { id: 'r2', item: 'Paint', vendor: 'Paint Shop', amount: 40, currency: 'USD', requestedBy: '', status: 'hr_approved', purchaseDate: '2026-10-28', paidOn: '', stage: 'posting' },
    ],
    purchaseRequests: [{ id: 'q1', item: 'Rebar', quantity: 4, requestedBy: 'Crew One', status: 'pending_manager', createdAt: '2026-11-02T10:00:00Z', stage: 'requested' }],
  },
  forecast: 750, variance: 250, percentSpent: 0.6, overBudget: false, booksError: '',
  ...over,
});
const loaded = (m) => ({ data: m, error: '', reload: vi.fn() });

beforeEach(() => {
  role = { manager: true };
  resetAccountingPrefs();
  api.getJobConnected.mockResolvedValue({ needsYou: {}, punch: {}, nextMilestones: [], crew: { people: [] }, tickets: [], names: {} });
  api.searchAccountingLedger.mockImplementation(async (q) => ({
    total: 2,
    rows: [
      { line_id: `${q.account}-a`, entry_id: 'e-1', entry_no: 'AP-1', entry_date: '2026-10-01', gl_code: q.account, account_name: 'Acct', item_id: 'CC-1', debit: 10, credit: 0 },
      { line_id: `${q.account}-b`, entry_id: 'e-2', entry_no: 'AP-2', entry_date: '2026-10-02', gl_code: q.account, account_name: 'Acct', item_id: '', debit: 5, credit: 0 },
    ],
  }));
  api.getAccountingEntry.mockResolvedValue({ entry: { entry_no: 'AP-1' }, lines: [], intacct: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Who sees Money', () => {
  it('the tab sits before Closeout on either size, only when allowed', () => {
    expect(jobTabs('project').some((t) => t.key === 'money')).toBe(false);
    expect(jobTabs('project', { money: true }).map((t) => t.key)).toEqual(['overview', 'schedule', 'punch', 'field', 'photos', 'rfis', 'drawings', 'permits', 'subs', 'changes', 'money', 'closeout']);
    expect(jobTabs('work_order', { money: true }).map((t) => t.label)).toEqual(['Overview', 'Tasks', 'Field', 'Photos', 'Changes', 'Money', 'Closeout']);
  });

  it('the Money tab rides in the URL', () => {
    expect(parseConstructionSub('project:j1:money').jobTab).toBe('money');
  });

  it('a manager with access gets the tab and the Overview line', async () => {
    api.getJobMoney.mockResolvedValue(money());
    const onTab = vi.fn();
    const { container } = render(<JobPage project={job} tab="overview" onTab={onTab} onBack={() => {}} />);
    expect(await screen.findByRole('tab', { name: 'Money' })).toBeInTheDocument();
    const line = container.querySelector('[data-money-line]');
    expect(line.textContent).toContain('Actual $600.00');
    expect(line.textContent).toContain('Budget $1,000.00');
    fireEvent.click(within(line).getByRole('button', { name: 'Open Money' }));
    expect(onTab).toHaveBeenCalledWith('money');
  });

  it('no tab and no line when the server says no; a crew screen never asks', async () => {
    api.getJobMoney.mockResolvedValue({ allowed: false, reason: 'Money needs Accounting access.' });
    const { container, unmount } = render(<JobPage project={job} tab="overview" onTab={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(api.getJobMoney).toHaveBeenCalledWith('j1'));
    await screen.findByText(/Nothing on this job is waiting on you/);
    expect(screen.queryByRole('tab', { name: 'Money' })).toBeNull();
    expect(container.querySelector('[data-money-line]')).toBeNull();
    unmount();
    api.getJobMoney.mockClear();
    role = {};
    render(<JobPage project={job} tab="money" onTab={() => {}} onBack={() => {}} />);
    await screen.findByText(/Nothing on this job is waiting on you/);
    expect(api.getJobMoney).not.toHaveBeenCalled();
    expect(screen.queryByRole('tab', { name: 'Money' })).toBeNull();
  });

  it('red once the server says Over Budget - actual + requested, the card\'s rule', () => {
    expect(spendTrack(money()).state).toBe('live');
    // 950 actual is under the 1,000 budget, but 950 + 100 requested is over: red.
    const over = spendTrack(money({ actual: { ...money().actual, amount: 950 }, overBudget: true }));
    expect(over).toMatchObject({ state: 'overdue', over: true, by: 50 });
    expect(usd(-1200)).toBe('($1,200.00)');
  });

  it('the Overview line goes red with the server and its Actual opens the ledger lines', async () => {
    const { container } = render(<MoneyLine money={loaded(money({ actual: { ...money().actual, amount: 950 }, overBudget: true }))} onOpen={() => {}} />);
    expect(container.querySelector('[data-money-line]').textContent).toContain('Over Budget by $50.00');
    fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind Actual to Date' }));
    await screen.findByRole('dialog', { name: 'Actual to Date' });
    expect(api.searchAccountingLedger.mock.calls.map(([q]) => [q.account, q.project, q.book])).toEqual([['17100', 'PJ-1', 'accrual'], ['61000', 'PJ-1', 'accrual']]);
  });
});

describe('The Money tab', () => {
  it('an amount opens its ledger lines with the Project-Job, and a line opens its entry', async () => {
    render(<MoneyTab project={job} money={loaded(money())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind Site Work' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledTimes(2));
    const asked = api.searchAccountingLedger.mock.calls.map(([q]) => q);
    expect(asked.map((q) => q.account)).toEqual(['17100', '61000']);
    for (const q of asked) {
      expect(q).toMatchObject({ project: 'PJ-1', item: 'CC-1', location: 'E1', to: '2026-11-03', book: 'accrual' });
      expect(q.from).toBeUndefined();
    }
    const panel = await screen.findByRole('dialog', { name: 'Site Work - Actual to Date' });
    fireEvent.click((await within(panel).findAllByRole('button', { name: 'AP-1' }))[0]);
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalledWith('e-1'));
  });

  it('No Cost Code reads every page and keeps only the lines with no item; the total reads every cost account', async () => {
    // 1,500 lines on the account, 20 of them with no cost code (each 5.00 = the 100.00 figure).
    const all = Array.from({ length: 1500 }, (_, i) => ({ line_id: `n${i}`, entry_id: `e${i}`, entry_no: `AP-${i}`, entry_date: '2026-10-01', gl_code: '61000', account_name: 'Repairs', item_id: i % 75 === 0 ? '' : 'CC-1', debit: i % 75 === 0 ? 5 : 1, credit: 0 }));
    api.searchAccountingLedger.mockImplementation(async (q) => ({ total: all.length, rows: all.slice(q.offset, q.offset + q.limit) }));
    render(<MoneyTab project={job} money={loaded(money())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind No Cost Code' }));
    const panel = await screen.findByRole('dialog', { name: 'No Cost Code - Actual to Date' });
    const table = await within(panel).findByRole('table', { name: /ledger lines/ });
    expect(within(table).getByText('Total - 20 lines')).toBeInTheDocument();
    expect(api.searchAccountingLedger.mock.calls.map(([q]) => [q.offset, q.limit])).toEqual([[0, 1000], [1000, 1000]]);
    expect(api.searchAccountingLedger.mock.calls[0][0].item).toBeUndefined();
    expect(panel.querySelector('[data-lines-check="ok"]').textContent).toContain('20 lines add up to the figure, 100.00');
    cleanup();
    api.searchAccountingLedger.mockClear();
    render(<MoneyTab project={job} money={loaded(money())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind the total' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledTimes(2));
    expect(api.searchAccountingLedger.mock.calls.map(([q]) => [q.account, q.project, q.item])).toEqual([['17100', 'PJ-1', undefined], ['61000', 'PJ-1', undefined]]);
    // Lines that do not add up to the figure say so.
    const totalPanel = await screen.findByRole('dialog', { name: 'Actual to Date' });
    await waitFor(() => expect(totalPanel.querySelector('[data-lines-check="short"]')).toBeTruthy());
  });

  it('reimbursements show their stage; only Requested, Not Yet Billed is summed; a hidden filer reads as a dash', () => {
    render(<MoneyTab project={job} money={loaded(money())} />);
    const table = screen.getByRole('table', { name: 'Reimbursements' });
    expect(within(table).getByText('Approved, Posting Soon')).toBeInTheDocument();
    const paint = within(table).getByText(/Paint - Paint Shop/).closest('tr');
    expect(paint.textContent).toContain('-');
    expect(paint.textContent).not.toContain('Crew One');
  });

  it('worked-out figures stay plain and say so; Nexus figures say where they come from', () => {
    const { container } = render(<MoneyTab project={job} money={loaded(money())} />);
    const fig = (k) => container.querySelector(`[data-money-figure="${k}"]`);
    expect(within(fig('actual')).getByRole('button')).toBeInTheDocument();
    for (const k of ['forecast', 'variance', 'budget', 'committed', 'pending', 'approved']) expect(within(fig(k)).queryByRole('button')).toBeNull();
    expect(fig('forecast').textContent).toContain('Worked out');
    expect(fig('budget').textContent).toContain("contract value");
    expect(screen.getAllByText('Requested, Not Yet Billed', { selector: '.nx-label-text' })).toHaveLength(2);
    expect(container.textContent).toContain('Not counted as cost');
  });

  it('every table has resizable columns, kept per person', async () => {
    render(<MoneyTab project={job} money={loaded(money())} />);
    const actual = screen.getByRole('table', { name: 'Actual to date' });
    for (const c of ['Cost Code', 'Accounts', 'Actual to Date', 'Share of Actual']) expect(within(actual).getByRole('separator', { name: `Resize the ${c} column` })).toBeInTheDocument();
    for (const t of ['Changes', 'Reimbursements', 'Purchase requests']) expect(within(screen.getByRole('table', { name: t })).getAllByRole('separator').length).toBeGreaterThan(0);
    fireEvent.doubleClick(within(actual).getByRole('separator', { name: 'Resize the Accounts column' }));
    await waitFor(() => expect(within(actual).getByRole('columnheader', { name: /Accounts/ }).style.width).toBe('60px'));
  });

  it('commitments: Committed is a figure, Billed to Date opens that vendor\'s lines, a billed vendor with no waiver is flagged', async () => {
    const commitments = {
      total: 900, open: 400, billedKnown: true,
      rows: [{
        id: 'k1', number: 'SC-001', kind: 'subcontract', kindLabel: 'Subcontract', vendorId: 'V-1', vendorName: 'Sample Plumbing',
        title: 'Plumbing', originalAmount: 900, amount: 900, retainagePct: 10, status: 'active', contractUrl: '', contractName: '', notes: '',
        billed: 500, billedAccounts: [{ account_no: '17100', title: 'Construction in Progress', amount: 500 }], sharedVendor: false,
        remaining: 400, retainageHeld: 50, waivers: [], lastWaiver: null, waiverMissing: true,
      }],
    };
    const { container } = render(<MoneyTab project={job} money={loaded(money({ commitments }))} />);
    expect(container.querySelector('[data-money-figure="commitments"]').textContent).toContain('$900.00');
    const table = screen.getByRole('table', { name: 'Commitments' });
    expect(within(table).getByText('No Waiver')).toBeInTheDocument();
    expect(within(table).getAllByRole('separator').length).toBeGreaterThan(0);
    fireEvent.click(within(table).getByRole('button', { name: 'Ledger lines behind Sample Plumbing billing' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledTimes(1));
    expect(api.searchAccountingLedger.mock.calls[0][0]).toMatchObject({ account: '17100', project: 'PJ-1', vendor: 'V-1', location: 'E1' });
    expect(api.searchAccountingLedger.mock.calls[0][0].item).toBeUndefined();
  });

  it('an unmapped job says so and reads nothing from the books', () => {
    const { container } = render(<MoneyTab project={job} money={loaded(money({ mapped: false, actual: null, percentSpent: null }))} onEdit={() => {}} />);
    expect(container.querySelector('[data-money-unmapped]')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Actual to date' })).toBeNull();
    expect(screen.getByRole('button', { name: /Map to the Books/ })).toBeInTheDocument();
    expect(api.searchAccountingLedger).not.toHaveBeenCalled();
  });
});

describe('Round Three - the client and cost codes', () => {
  const client = { billed: { amount: 900, accounts: [{ account_no: '40100', title: 'Revenue', amount: 900 }] },
    received: { amount: 600, accounts: [{ account_no: '12000', title: 'Accounts Receivable', amount: 600 }] }, open: 300 };

  it('the client card reads billed, received and owed, and billed opens its lines without a cost code', async () => {
    const { container } = render(<MoneyTab project={{ ...job, clientId: 'C-1', clientName: 'Sample Owner LLC' }} money={loaded(money({ client }))} />);
    expect(screen.getByText('From the Client - Sample Owner LLC')).toBeInTheDocument();
    expect(container.querySelector('[data-money-figure="billed"]').textContent).toContain('$900.00');
    expect(container.querySelector('[data-money-figure="owed"]').textContent).toContain('$300.00');
    expect(container.querySelector('[data-money-figure="to-bill"]').textContent).toContain('$100.00');
    fireEvent.click(screen.getByRole('button', { name: 'Ledger lines behind Billed to Client' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledTimes(1));
    const q = api.searchAccountingLedger.mock.calls[0][0];
    expect(q).toMatchObject({ account: '40100', project: 'PJ-1', location: 'E1' });
    expect(q.item).toBeUndefined();
  });

  it('a job with no client says where to set it', () => {
    render(<MoneyTab project={job} money={loaded(money({ client }))} />);
    expect(screen.getByText(/No client is set on this job/)).toBeInTheDocument();
  });

  it('Committed sits beside Actual per cost code, a code with only commitments gets its own row', () => {
    render(<MoneyTab project={job} money={loaded(money({ committedByCode: { 'CC-1': 300, 'CC-9': 200 } }))} />);
    const table = screen.getByRole('table', { name: 'Actual to date' });
    expect(within(table).getByRole('columnheader', { name: /Committed/ })).toBeInTheDocument();
    const nine = table.querySelector('[data-money-row="CC-9"]');
    expect(nine.textContent).toContain('200.00');
    expect(nine.textContent).not.toContain('0.0%');
    expect(within(nine).queryByRole('button')).toBeNull();
  });

  it('Edit Job picks the client from Intacct and the one Save sets it with the contact', async () => {
    api.searchJobCustomers.mockResolvedValue({ customers: [{ id: 'C-1', name: 'Sample Owner LLC', contactName: 'Dana Owens', contactEmail: 'Dana@Owner.com' }] });
    api.setJobClient.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    api.getBookProjects.mockResolvedValue({ limited: false, entities: [], codes: [], entity: '' });
    render(<EditJobSheet project={job} money={loaded(money())} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a customer' }), { target: { value: 'sample' } });
    fireEvent.click(await screen.findByRole('option', { name: /Sample Owner LLC/ }));
    expect(screen.getByRole('textbox', { name: 'Who Signs' })).toHaveValue('Dana Owens');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1));
    await waitFor(() => expect(api.setJobClient).toHaveBeenCalledWith('j1', { client_id: 'C-1', contact_name: 'Dana Owens', contact_email: 'dana@owner.com' }));
    expect(api.updateConstructionProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('Edit Job - the Books rows', () => {
  it('a manager with access picks the entity and the Project-Job and the one Save maps it', async () => {
    api.getBookProjects.mockImplementation(async (entity) => ({ limited: false, entities: [{ code: 'E1', name: 'Test Entity' }, { code: 'E2', name: 'Other Entity' }], codes: entity ? [{ code: 'PJ-2', name: 'Second', onEntity: false }] : [], entity }));
    api.mapJobBooks.mockResolvedValue({ link: { project: 'PJ-2', entity: 'E2' } });
    const onSaved = vi.fn();
    render(<EditJobSheet project={job} money={loaded(money())} onClose={() => {}} onSaved={onSaved} />);
    const entity = await screen.findByRole('combobox', { name: 'Entity' });
    await waitFor(() => expect(within(entity).getByRole('option', { name: 'Other Entity (E2)' })).toBeInTheDocument());
    fireEvent.change(entity, { target: { value: 'E2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Project-Job' }), { target: { value: 'PJ-2' } });
    // No lines on that entity yet: a warning, never a block.
    await waitFor(() => expect(document.querySelector('[data-books-warning]').textContent).toContain('It saves'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1));
    await waitFor(() => expect(api.mapJobBooks).toHaveBeenCalledWith('j1', { intacctProjectId: 'PJ-2', intacctEntity: 'E2' }));
    expect(api.updateConstructionProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('no Books rows without Money access', () => {
    render(<EditJobSheet project={job} money={loaded({ allowed: false })} onClose={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Entity' })).toBeNull();
    // Nor the Client picker: Intacct's customer list carries contacts (review, 11/11/2026).
    expect(screen.queryByRole('textbox', { name: 'Find a customer' })).toBeNull();
    expect(api.getBookProjects).not.toHaveBeenCalled();
  });
});

describe('Over Budget and the job tag', () => {
  it('Over Budget joins the health facts', () => {
    expect(healthFacts(job.health, { overBudget: true }).map((f) => f.text)).toContain('Over Budget');
    expect(healthFacts(job.health).map((f) => f.text)).not.toContain('Over Budget');
  });

  it('the Job picker lists the jobs the person may read, and nothing for someone on none', async () => {
    api.getSpendJobs.mockResolvedValue({ jobs: [{ id: 'j1', name: 'Sample Build', code: 'SB-1' }] });
    const onChange = vi.fn();
    const { unmount } = render(<JobTagSelect value="" onChange={onChange} />);
    const select = await screen.findByRole('combobox', { name: 'Job' });
    fireEvent.change(select, { target: { value: 'j1' } });
    expect(onChange).toHaveBeenCalledWith('j1');
    expect(within(select).getByRole('option', { name: 'Sample Build (SB-1)' })).toBeInTheDocument();
    unmount();
    api.getSpendJobs.mockResolvedValue({ jobs: [] });
    const { container } = render(<JobTagSelect value="" onChange={onChange} />);
    await waitFor(() => expect(api.getSpendJobs).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-job-tag]')).toBeNull();
  });
});
