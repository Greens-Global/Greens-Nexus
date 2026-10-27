import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

// Accounting > Reporting > Employee Compensation (Oct 15): renders people and
// the totals views, the ledger payroll expense, and the step-up gate.

const total = (o) => ({ key: '', label: 'Total', currency: 'USD', people: 1, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, overtimeMin: 300, leaveMin: 960, wages: 5000, ...o });
const report = {
  from: '2026-01-01', to: '2026-09-30', months: ['2026-01'],
  people: [{ email: 'pat@x.com', name: 'Pat Hourly', employeeId: 'GG-001', company: 'c1', companyName: 'Greens Global', department: 'Maintenance', title: 'Technician',
    payType: 'hourly', currency: 'USD', rate: 26, rateChanged: true, regMin: 9600, otMin: 240, dtMin: 60, sickMin: 960, vacationMin: 0, personalMin: 0, overtimeMin: 300, leaveMin: 960, wages: 5000 }],
  byCompany: [total({ key: 'c1', label: 'Greens Global' })],
  byDepartment: [total({ key: 'Maintenance', label: 'Maintenance' })],
  totals: [total()],
};
const ledger = { by: 'department', rows: [{ key: '9100', label: 'Field Ops', wages: 1000, taxes: 80, benefits: 20, total: 1100, accounts: [] }], totals: { wages: 1000, taxes: 80, benefits: 20, total: 1100 } };

vi.mock('../../api', () => ({
  api: {
    getCompensationPeople: vi.fn(async () => report),
    getCompensationLedger: vi.fn(async () => ledger),
  },
}));
vi.mock('../../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ label, onVerified }) => <button type="button" onClick={onVerified}>Verify {label}</button>,
}));

// Export hands its file to downloadBlob; caught here so a test can read what was written (10/27).
vi.mock('./reportModel', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import CompensationReport from './CompensationReport';
import { downloadBlob } from './reportModel';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

// The standard table view keeps a person's filters (10/23 item 01): each test starts clean.
beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); try { localStorage.clear(); } catch { /* private mode */ } });


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
describe('CompensationReport', () => {
  // 10/23 meeting, item 05 (fix 10/24): the page does not scroll; each table scrolls in its own card.
  it('is as tall as the window, the people and the ledger each scrolling in their own card', async () => {
    render(<CompensationReport />);
    await screen.findByText('Field Ops');
    const stack = screen.getByTestId('compensation-stack');
    expect(stack.className).toBe('acct-fit-stack');
    await waitFor(() => expect(stack.style.getPropertyValue('--acct-box-h')).toMatch(/px$/));
    const people = screen.getByRole('heading', { name: 'Compensation' }).closest('.acct-stack-card');
    const books = screen.getByRole('heading', { name: 'Payroll Expense on the Ledger' }).closest('.acct-stack-card');
    expect(people.className).toContain('acct-stack-main');   // the people table gets the larger share
    expect(people.parentElement).toBe(stack);
    expect(books.parentElement).toBe(stack);
    expect(people.style.overflow).toBe('');
    expect(books.style.overflow).toBe('');
    // The rules: the cards share the height and scroll, headings pinned; the bar keeps its height.
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('.acct-fit-stack { display: flex; flex-direction: column; gap: 10px; height: var(--acct-box-h');
    expect(css).toContain('.acct-fit-stack > .acct-stack-card { overflow: auto; }');
    expect(css).toContain('.acct-fit-stack > .acct-stack-card table > thead th { position: sticky; top: 0;');
    expect(css).toContain('.acct-fit-stack > .acct-controlbar { flex: 0 0 auto; }');
    // Round 3: the people table's headings carry position: relative (their drag handle), which stopped
    // the per-cell rule pinning them; the whole heading block pins instead (acct-sticky-head).
    expect(people.querySelector('table').classList.contains('acct-sticky-head')).toBe(true);
    expect(css).toContain('.acct-sticky-head.acct-sticky-head thead { position: sticky; top: 0; z-index: 3; }');
  });

  it('renders each person with hours and wages, and the ledger payroll', async () => {
    render(<CompensationReport />);
    expect(await screen.findByText('Pat Hourly')).toBeTruthy();
    expect(screen.getByText('Technician')).toBeTruthy();
    expect(screen.getAllByText('160.00').length).toBe(2);   // regular hours, and the total
    expect(screen.getByText('Overtime Hours')).toBeTruthy();
    expect(screen.getByText('Gross Wages')).toBeTruthy();
    expect(await screen.findByText('Field Ops')).toBeTruthy();
    expect(screen.getByText('Employer Taxes')).toBeTruthy();
    expect(api.getCompensationLedger).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'department');
  });

  it('has the standard table view: a value list narrows the people and the Total follows (10/23, item 01)', async () => {
    const lee = { ...report.people[0], email: 'lee@x.com', name: 'Lee Salaried', employeeId: 'MC-002', company: 'c2', companyName: 'MCD Services', payType: 'salary', rate: 6000, rateChanged: false, regMin: 4800, otMin: 0, dtMin: 0, sickMin: 0, wages: 2000 };
    api.getCompensationPeople.mockResolvedValueOnce({ ...report, people: [report.people[0], lee], totals: [total({ people: 2, regMin: 14400, wages: 7000 })] });
    render(<CompensationReport />);
    await screen.findByText('Lee Salaried');
    const totalRow = () => within(screen.getByRole('heading', { name: 'Compensation' }).closest('.acct-stack-card')).getByText('Total', { selector: 'td' }).closest('tr');
    expect(totalRow().textContent).toContain('7,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Filter Company by value' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Company values' })).getByRole('checkbox', { name: /Greens Global/ }));
    expect(screen.queryByText('Pat Hourly')).toBeNull();
    expect(totalRow().textContent).toContain('2,000.00');
    expect(totalRow().textContent).toContain('80.00');     // Lee's 4,800 minutes of regular time
  });

  it('switches to the totals by company', async () => {
    render(<CompensationReport />);
    await screen.findByText('Pat Hourly');
    fireEvent.click(screen.getByRole('button', { name: 'By Company' }));
    expect(screen.queryByText('Pat Hourly')).toBeNull();
    expect(screen.getByText('Employees')).toBeTruthy();
  });

  it('asks for a fresh identity check when the backend wants one', async () => {
    api.getCompensationPeople.mockRejectedValueOnce(Object.assign(new Error('stepup_required'), { status: 403 }));
    render(<CompensationReport />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify/ }));
    expect(await screen.findByText('Pat Hourly')).toBeTruthy();
    expect(api.getCompensationPeople).toHaveBeenCalledTimes(2);
  });

  it('says how many months it is building while it loads, and asks for one attempt', async () => {
    let resolve;
    api.getCompensationPeople.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<CompensationReport />);
    expect(screen.getByRole('status').textContent).toMatch(/^Building \d+ months? of payroll cards/);
    expect(api.getCompensationPeople).toHaveBeenCalledWith(expect.any(String), expect.any(String), { timeoutMs: 180_000 });
    resolve(report);
    expect(await screen.findByText('Pat Hourly')).toBeTruthy();
  });

  it('an empty report says why', async () => {
    api.getCompensationPeople.mockResolvedValueOnce({ ...report, people: [], byCompany: [], byDepartment: [], totals: [], coverage: { roster: 12, punches: 0, ratesSet: 12 } });
    render(<CompensationReport />);
    expect(await screen.findByText(/No one punched in Time Clock in these months/)).toBeTruthy();
    expect(screen.getByText(/12 people are on the roster/)).toBeTruthy();
  });

  it('a run that ran out of time says so, with what to do', async () => {
    api.getCompensationPeople.mockRejectedValueOnce(Object.assign(new Error("Can't reach Nexus right now."), { name: 'AbortError', isNetworkError: true }));
    render(<CompensationReport />);
    expect(await screen.findByText(/took longer than 3 minutes, so it was stopped\. Pick fewer months/)).toBeTruthy();
  });

  it('shows the ledger split Direct / Indirect', async () => {
    api.getCompensationLedger.mockResolvedValueOnce({ ...ledger, rows: [{ ...ledger.rows[0], direct: 700, indirect: 400 }], totals: { ...ledger.totals, direct: 700, indirect: 400 } });
    render(<CompensationReport />);
    expect(await screen.findByText('Field Ops')).toBeTruthy();
    expect(screen.getByText('Direct')).toBeTruthy();
    expect(screen.getByText('Indirect')).toBeTruthy();
  });

  it('refuses a range longer than a year', async () => {
    render(<CompensationReport />);
    await screen.findByText('Pat Hourly');
    fireEvent.change(screen.getByLabelText('From Month'), { target: { value: '2024-01' } });
    expect(screen.getByText('Pick at most 12 months.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Report' })).toBeDisabled();
  });
});

// 10/27: a filter box under every heading on both tables (columnFilters.jsx, as
// on MRE): typing narrows the rows, the Total line follows, and Export writes
// only what the boxes leave.
describe('CompensationReport - column filter boxes (10/27)', () => {
  const lee = { ...report.people[0], email: 'lee@x.com', name: 'Lee Salaried', employeeId: 'MC-002', company: 'c2', companyName: 'MCD Services', department: 'Office', payType: 'salary', rate: 6000, rateChanged: false, regMin: 4800, otMin: 0, dtMin: 0, sickMin: 0, wages: 2000 };
  const csvOf = async () => {
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const file = downloadBlob.mock.calls[downloadBlob.mock.calls.length - 1][1];
    return new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result)); fr.readAsText(file); });
  };
  const peopleCard = () => screen.getByRole('heading', { name: 'Compensation' }).closest('.acct-stack-card');
  const ledgerCard = () => screen.getByRole('heading', { name: 'Payroll Expense on the Ledger' }).closest('.acct-stack-card');

  it('people: a text box and an amount box narrow the rows, the Total follows, and Export writes only them', async () => {
    api.getCompensationPeople.mockResolvedValueOnce({ ...report, people: [report.people[0], lee], totals: [total({ people: 2, regMin: 14400, wages: 7000 })] });
    render(<CompensationReport />);
    await screen.findByText('Lee Salaried');
    const people = peopleCard();
    const table = people.querySelector('table');
    // The boxes are in the pinned heading block.
    const box = within(people).getByRole('textbox', { name: 'Filter Employee' });
    expect(table.querySelector('thead').contains(box)).toBe(true);
    expect(table.classList.contains('acct-sticky-head')).toBe(true);
    // The Employee box also finds the employee ID.
    fireEvent.change(box, { target: { value: 'mc-002' } });
    expect(screen.queryByText('Pat Hourly')).toBeNull();
    const totalRow = () => within(people).getByText('Total', { selector: 'td' }).closest('tr');
    expect(totalRow().textContent).toContain('2,000.00');
    expect(within(people).getByText(/1 of 2 rows pass the filters/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    // Gross Wages > 3,000: Pat only.
    fireEvent.change(within(people).getByRole('combobox', { name: 'Operator for Gross Wages' }), { target: { value: '>' } });
    fireEvent.change(within(people).getByRole('textbox', { name: 'Filter Gross Wages' }), { target: { value: '3000' } });
    expect(screen.queryByText('Lee Salaried')).toBeNull();
    expect(totalRow().textContent).toContain('5,000.00');
    // The people's Export is the bar's, the first on the screen.
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    const text = await csvOf();
    expect(text).toContain('Pat Hourly');
    expect(text).not.toContain('Lee Salaried');
  });

  it('people: nothing left keeps the boxes with a way to clear them; another grouping starts clean', async () => {
    render(<CompensationReport />);
    await screen.findByText('Pat Hourly');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Title' }), { target: { value: 'accountant' } });
    expect(within(peopleCard()).getByText('Nothing matches these column filters.')).toBeTruthy();
    fireEvent.click(within(peopleCard()).getByRole('button', { name: 'Clear Column Filters' }));
    expect(screen.getByText('Pat Hourly')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Title' }), { target: { value: 'accountant' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'By Department' }));
    expect(within(peopleCard()).getByRole('textbox', { name: 'Filter Department' }).value).toBe('');
    expect(within(peopleCard()).getAllByText('Maintenance').length).toBeGreaterThan(0);
  });

  it('ledger: its own boxes narrow the rows, the Total follows, and its Export writes only them', async () => {
    api.getCompensationLedger.mockResolvedValue({ ...ledger, rows: [ledger.rows[0], { key: '9200', label: 'Office', wages: 500, taxes: 40, benefits: 10, total: 550, accounts: [] }], totals: { wages: 1500, taxes: 120, benefits: 30, total: 1650 } });
    render(<CompensationReport />);
    await screen.findByText('Office', { selector: 'td' });
    const card = ledgerCard();
    const box = within(card).getByRole('textbox', { name: 'Filter Department' });
    expect(card.querySelector('table thead').contains(box)).toBe(true);
    // The Department box also finds the code shown beside the name.
    fireEvent.change(box, { target: { value: '9100' } });
    expect(within(card).queryByText('Office')).toBeNull();
    const foot = card.querySelector('tfoot tr');
    expect(foot.textContent).toContain('1,100.00');
    expect(foot.textContent).not.toContain('1,650.00');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(within(card).getByRole('combobox', { name: 'Operator for Total' }), { target: { value: '<' } });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Filter Total' }), { target: { value: '1000' } });
    expect(within(card).queryByText('Field Ops')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    const text = await csvOf();
    expect(text).toContain('Office');
    expect(text).not.toContain('Field Ops');
    expect(text).toContain('550');
  });
});
