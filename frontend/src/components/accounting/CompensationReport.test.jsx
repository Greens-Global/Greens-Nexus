import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

// Accounting > Reporting > Employee Compensation, rebuilt from the Intacct
// ledger after the 10/27 call with Charmi (items 11-19): the ledger's figures
// per employee with Time Clock's hours beside them, one table, a person's
// full report on the right, every amount opening its ledger lines, loading
// dots, the photo beside the name, and the step-up gate.

const lines = (o = {}) => ({ bonus: 0, payroll: 0, totalPayroll: 0, k401: 0, health: 0, otherBenefits: 0, totalBenefits: 0, futa: 0, medicare: 0, socsec: 0, suta: 0, ett: 0, otherTaxes: 0,
  totalTaxes: 0, workersComp: 0, totalEmployer: 0, dedHealth: 0, ded401k: 0, dedOther: 0, totalDeductions: 0, fedWh: 0, medicareWh: 0, socsecWh: 0, sdi: 0, stateWh: 0, totalWithheld: 0, netPay: 0, ...o });
const valinda = {
  code: 'E-0084', name: 'Valinda Cranfill', email: 'valinda@x.com', company: 'c1', companyName: 'Oversite Management, Inc', department: 'Operations', title: 'Area Manager III', inPeople: true, hasRate: true,
  cur: lines({ bonus: 850, payroll: 52123.06, totalPayroll: 52973.06, health: 3249.75, otherBenefits: 20, totalBenefits: 3269.75, workersComp: 1854.06, totalEmployer: 58096.87, dedHealth: -5854.22, totalDeductions: -5854.22, netPay: 47118.84 }),
  prior: lines({ bonus: 3500, payroll: 57176.84, totalPayroll: 60676.84, totalEmployer: 60676.84, netPay: 60676.84 }),
  accounts: { cur: { bonus: [{ account: '61908', title: 'Bonus', side: '', amount: 850 }], payroll: [{ account: '61910', title: 'Salary', side: '', amount: 52123.06 }],
    health: [{ account: '61903', title: 'Health Insurance', side: 'd', amount: 3249.75 }], dedHealth: [{ account: '61903', title: 'Health Insurance', side: 'c', amount: -5854.22 }],
    otherBenefits: [{ account: '63203', title: 'Fuel', side: '', amount: 20 }] }, prior: { bonus: [{ account: '61908', title: 'Bonus', side: '', amount: 3500 }] } },
  workersComp: { cur: [{ year: 2026, ratePct: 3.5, rateYear: 2026, gross: 52973.06, amount: 1854.06 }], prior: [] },
};
const lee = { ...valinda, code: 'MC-002', name: 'Lee Salaried', email: '', company: 'c2', companyName: 'MCD Services', department: 'Office', title: 'Accountant', hasRate: false,
  cur: lines({ payroll: 2000, totalPayroll: 2000, totalEmployer: 2000, netPay: 2000 }), prior: lines(),
  accounts: { cur: { payroll: [{ account: '61910', title: 'Salary', side: '', amount: 2000 }] }, prior: {} }, workersComp: { cur: [], prior: [] } };
const report = { from: '2026-01-01', to: '2026-12-31', months: ['2026-01'], prior: { from: '2025-01-01', to: '2025-12-31' }, people: [valinda], notInPeople: 0 };
const hours = { people: [{ employeeId: 'E-0084', name: 'Valinda Cranfill', regMin: 6000, otMin: 0, dtMin: 0, sickMin: 480, vacationMin: 0, payType: 'salary', rate: 5133.33 }] };
const ledgerLines = { from: '2026-01-01', to: '2026-12-31', total: 850, truncated: false,
  lines: [{ id: 'l1', entryId: 'e1', entryNo: 'PYRJ-12', date: '2026-03-15', account: '61908', accountName: 'Bonus', vendor: '', memo: 'Q1 bonus', amount: 850 }] };

vi.mock('../../api', () => ({
  api: {
    getCompensationReport: vi.fn(async () => report),
    getCompensationPeople: vi.fn(async () => hours),
    getCompensationLines: vi.fn(async () => ledgerLines),
    getPeopleDirectory: vi.fn(async () => []),
  },
  withFreshReads: (fn) => fn(),
}));
vi.mock('../../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ label, onVerified }) => <button type="button" onClick={onVerified}>Verify {label}</button>,
}));
// The photo beside each name is the app's Avatar (tasks/components), whose hover card reads the signed-in role.
vi.mock('../../contexts/RoleContext', async (importOriginal) => ({ ...(await importOriginal()), useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
vi.mock('./drill', async (importOriginal) => ({ ...(await importOriginal()), requestReportDrill: vi.fn(), parkDrillReturn: vi.fn() }));

// Export hands its file to downloadBlob; caught here so a test can read what was written (10/27).
vi.mock('./reportModel', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import CompensationReport from './CompensationReport';
import { downloadBlob } from './reportModel';
import { requestReportDrill, parkDrillReturn } from './drill';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

// The standard table view keeps a person's filters (10/23 item 01): each test starts clean.
beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });

// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);

const mainCard = () => screen.getByRole('heading', { name: 'Compensation' }).closest('.acct-stack-card');
const panel = () => screen.getByTestId('acct-side-panel');
const csvOf = async () => {
  await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
  const file = downloadBlob.mock.calls[downloadBlob.mock.calls.length - 1][1];
  return new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result)); fr.readAsText(file); });
};

describe('CompensationReport', () => {
  it('is one table as tall as the window - the lower ledger box is gone (item 16)', async () => {
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    const stack = screen.getByTestId('compensation-stack');
    expect(stack.className).toBe('acct-fit-stack');
    await waitFor(() => expect(stack.style.getPropertyValue('--acct-box-h')).toMatch(/px$/));
    expect(mainCard().className).toContain('acct-stack-main');
    expect(mainCard().parentElement).toBe(stack);
    expect(screen.queryByText('Payroll Expense on the Ledger')).toBeNull();
    expect(stack.querySelectorAll('.acct-stack-card')).toHaveLength(1);
    // By Employee / By Company / By Department stay at the top.
    expect(within(screen.getByRole('group', { name: 'View' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['By Employee', 'By Company', 'By Department']);
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('.acct-sticky-head.acct-sticky-head thead { position: sticky; top: 0; z-index: 3; }');
    expect(mainCard().querySelector('table').classList.contains('acct-sticky-head')).toBe(true);
  });

  it('shows the ledger\'s figures (Valinda: Salaried Payroll 52,123.06, Bonus 850.00) with Time Clock\'s hours, labeled (item 11)', async () => {
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    expect(api.getCompensationReport).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-01$/), expect.stringMatching(/^\d{4}-12$/));
    const row = screen.getByText('Valinda Cranfill').closest('tr');
    expect(row.textContent).toContain('52,123.06');
    expect(row.textContent).toContain('850.00');
    expect(row.textContent).toContain('1,854.06');      // workers' comp
    await waitFor(() => expect(row.textContent).toContain('100.00'));   // 6,000 minutes of regular time
    expect(screen.getByText('Regular Hours (Time Clock)')).toBeTruthy();
    expect(screen.getByText('Salaried / Hourly Payroll')).toBeTruthy();
    expect(screen.getByText('Total Employer Expenses')).toBeTruthy();
    expect(screen.queryByText(/Personal Hours/)).toBeNull();   // item 15
    expect(screen.getByText('Year Ending 12/31/2026 · 1 employee')).toBeTruthy();
  });

  it('puts the profile photo, or the initials, left of each name (item 19)', async () => {
    render(<CompensationReport />);
    const name = await screen.findByText('Valinda Cranfill');
    const btn = name.closest('button');
    expect(btn.firstChild.textContent).toBe('VC');
    expect(btn.textContent).toContain('E-0084');
  });

  it('shows centered loading dots with the building message while it loads - never the pale blocks (item 18)', async () => {
    let resolve;
    api.getCompensationReport.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const { container } = render(<CompensationReport />);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/^Loading\.\.\.Building \d+ months? of payroll cards/);
    expect(status.style.justifyContent).toBe('center');
    expect(container.querySelector('.nx-skel')).toBeNull();
    resolve(report);
    expect(await screen.findByText('Valinda Cranfill')).toBeTruthy();
  });

  it('shows the ledger figures while Time Clock still builds the hours, and says so', async () => {
    let resolve;
    api.getCompensationPeople.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    expect(screen.getByText(/Loading Time Clock hours/)).toBeTruthy();
    expect(api.getCompensationPeople).toHaveBeenCalledWith(expect.any(String), expect.any(String), { timeoutMs: 180_000 });
    resolve(hours);
    await waitFor(() => expect(screen.queryByText(/Loading Time Clock hours/)).toBeNull());
  });

  it('a Time Clock failure keeps the ledger figures and offers Try Again', async () => {
    api.getCompensationPeople.mockRejectedValueOnce(Object.assign(new Error("Can't reach Nexus right now."), { name: 'AbortError', isNetworkError: true }));
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Time Clock hours could not be built: Building \d+ months? took longer than 3 minutes/);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(api.getCompensationPeople).toHaveBeenCalledTimes(2));
  });

  it('a name opens the person\'s report, Intacct\'s layout with last year beside it (item 13)', async () => {
    render(<CompensationReport />);
    fireEvent.click(await screen.findByTitle("Open Valinda Cranfill's compensation report"));
    const p = panel();
    expect(within(p).getByRole('heading', { name: 'Valinda Cranfill (E-0084)' })).toBeTruthy();
    expect(within(p).getByRole('button', { name: /Open Full/ })).toBeTruthy();
    const table = within(p).getByRole('table', { name: /Employee Compensation Report/ });
    expect(within(table).getByText('Year Ending 12/31/2025')).toBeTruthy();
    expect(within(table).getByText('Year Ending 12/31/2026')).toBeTruthy();
    for (const h of ['Hours (from Time Clock)', 'Payroll Expenses', 'Benefits', 'Employer Payroll Taxes', 'Deductions from Gross Pay', 'Employee Taxes Withheld']) expect(within(table).getByText(h)).toBeTruthy();
    expect(within(table).getByText('Salaried / Hourly Payroll').closest('tr').textContent).toContain('57,176.84');
    expect(within(table).getByText('63203 Fuel')).toBeTruthy();   // Other Benefits by account (item 12)
    expect(within(p).getByText(/2026: 3.5% of 52,973.06 gross wages = 1,854.06/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('acct-side-panel')).toBeNull();
  });

  it('every amount opens its ledger lines on the right; Open in Reports goes on to the General Ledger and back (item 17)', async () => {
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    fireEvent.click(screen.getByRole('button', { name: 'Bonus for Valinda Cranfill: 850.00 - open the ledger lines' }));
    await waitFor(() => expect(api.getCompensationLines).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-12-31', employees: ['E-0084'], accounts: ['61908'] }));
    const p = panel();
    expect(within(p).getByRole('heading', { name: 'Bonus' })).toBeTruthy();
    const table = await within(p).findByRole('table', { name: /Ledger lines/ });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'Entry', 'Account', 'Vendor', 'Memo', 'Amount']);
    expect(within(table).getByText('03/15/2026')).toBeTruthy();
    expect(within(table).getByText('Q1 bonus')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: '61908 Bonus' }));
    expect(parkDrillReturn).toHaveBeenCalledWith('compensation', expect.objectContaining({ view: 'people' }));
    expect(requestReportDrill).toHaveBeenCalledWith(expect.objectContaining({ account: '61908', from: '2026-01-01', to: '2026-12-31',
      party: { kind: 'employee', code: 'E-0084', name: 'Valinda Cranfill' }, back: { label: 'Back to Compensation', sub: 'compensation' } }));
  });

  it('from the person\'s report, a figure opens its lines with a way back; the health split asks for one side only', async () => {
    render(<CompensationReport />);
    fireEvent.click(await screen.findByTitle("Open Valinda Cranfill's compensation report"));
    fireEvent.click(within(panel()).getByRole('button', { name: /^Health Insurance \(Employee\) for Valinda Cranfill, Year Ending 12\/31\/2026/ }));
    await waitFor(() => expect(api.getCompensationLines).toHaveBeenCalledWith(expect.objectContaining({ accounts: ['61903:c'] })));
    fireEvent.click(within(panel()).getByRole('button', { name: "Back to Valinda Cranfill's report" }));
    expect(within(panel()).getByRole('table', { name: /Employee Compensation Report/ })).toBeTruthy();
    // Last year's column drills into last year.
    fireEvent.click(within(panel()).getByRole('button', { name: /^Bonus for Valinda Cranfill, Year Ending 12\/31\/2025/ }));
    await waitFor(() => expect(api.getCompensationLines).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2025-12-31', employees: ['E-0084'], accounts: ['61908'] }));
  });

  it('switches to the totals by company, each group opening its own report', async () => {
    api.getCompensationReport.mockResolvedValueOnce({ ...report, people: [valinda, lee] });
    render(<CompensationReport />);
    await screen.findByText('Lee Salaried');
    fireEvent.click(screen.getByRole('button', { name: 'By Company' }));
    expect(screen.queryByText('Lee Salaried')).toBeNull();
    expect(screen.getByText('Employees')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Open the compensation report for MCD Services'));
    expect(within(panel()).getByRole('heading', { name: 'MCD Services' })).toBeTruthy();
  });

  it('asks for a fresh identity check when the backend wants one', async () => {
    api.getCompensationReport.mockRejectedValueOnce(Object.assign(new Error('stepup_required'), { status: 403 }));
    render(<CompensationReport />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify/ }));
    expect(await screen.findByText('Valinda Cranfill')).toBeTruthy();
    expect(api.getCompensationReport).toHaveBeenCalledTimes(2);
  });

  it('an empty report says why', async () => {
    api.getCompensationReport.mockResolvedValueOnce({ ...report, people: [] });
    render(<CompensationReport />);
    expect(await screen.findByText(/No payroll on the ledger carries an employee in these months/)).toBeTruthy();
  });

  it('refuses a range longer than a year', async () => {
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    fireEvent.change(screen.getByLabelText('From Month'), { target: { value: '2024-01' } });
    expect(screen.getByText('Pick at most 12 months.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Report' })).toBeDisabled();
  });
});

// 10/27: a filter box under every heading (columnFilters.jsx, as on MRE):
// typing narrows the rows, the Total line follows, Export writes only what
// the boxes leave, and nothing left is the shared row with its gray link.
describe('CompensationReport - column filter boxes (10/27)', () => {
  it('a text box and an amount box narrow the rows, the Total follows, and Export writes only them', async () => {
    api.getCompensationReport.mockResolvedValueOnce({ ...report, people: [valinda, lee] });
    render(<CompensationReport />);
    await screen.findByText('Lee Salaried');
    const card = mainCard();
    const box = within(card).getByRole('textbox', { name: 'Filter Employee' });
    expect(card.querySelector('table thead').contains(box)).toBe(true);
    const totalRow = () => card.querySelector('tfoot tr');
    expect(totalRow().textContent).toContain('54,123.06');
    // The Employee box also finds the employee ID.
    fireEvent.change(box, { target: { value: 'mc-002' } });
    expect(screen.queryByText('Valinda Cranfill')).toBeNull();
    expect(totalRow().textContent).toContain('2,000.00');
    expect(within(card).getByText(/1 of 2 rows pass the filters/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(within(card).getByRole('combobox', { name: 'Operator for Salaried / Hourly Payroll' }), { target: { value: '>' } });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Filter Salaried / Hourly Payroll' }), { target: { value: '3000' } });
    expect(screen.queryByText('Lee Salaried')).toBeNull();
    expect(totalRow().textContent).toContain('52,123.06');
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    const text = await csvOf();
    expect(text).toContain('Valinda Cranfill');
    expect(text).toContain('52123.06');
    expect(text).not.toContain('Lee Salaried');
    expect(text).not.toMatch(/Personal/);
  });

  it('nothing left is the shared row with a gray Clear Column Filters link; another grouping starts clean', async () => {
    render(<CompensationReport />);
    await screen.findByText('Valinda Cranfill');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Department' }), { target: { value: 'nowhere' } });
    expect(within(mainCard()).getByText(/Nothing matches these column filters\./)).toBeTruthy();
    const clear = within(mainCard()).getByRole('button', { name: 'Clear Column Filters' });
    expect(clear.getAttribute('style')).not.toContain('wk-brand');
    fireEvent.click(clear);
    expect(screen.getByText('Valinda Cranfill')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Department' }), { target: { value: 'nowhere' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'By Department' }));
    expect(within(mainCard()).getByRole('textbox', { name: 'Filter Department' }).value).toBe('');
    expect(within(mainCard()).getAllByText('Operations').length).toBeGreaterThan(0);
  });
});
