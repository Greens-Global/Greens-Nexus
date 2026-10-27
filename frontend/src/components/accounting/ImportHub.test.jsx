import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Import Hub (Neil, 10/15): the three tool cards, the Payroll Hours card
// loading Nexus hours and downloading the QuickBooks IIF, and the
// QuickBooks Payroll card turning a report into a balanced Intacct import.

// Statement rules the team saved (10/27 item 01): interest in, the AAA autopay out.
const RULES = vi.hoisted(() => [
  { id: 'r1', matchText: 'INTEREST PAYMENT', matchType: 'contains', direction: 'in', amount: null, account: '40100', accountName: 'Interest Income', vendorId: '', customerId: '', priority: 100, active: true, notes: '' },
  { id: 'r2', matchText: 'AAA INSURANCE', matchType: 'contains', direction: 'out', amount: null, account: '61500', accountName: '', vendorId: 'V00037', vendorName: 'AAA Insurance', customerId: '', priority: 100, active: true, notes: '' },
]);
const hours = { rows: [
  { email: 'pat@x.com', name: 'Pat Lane', approved: true, finalized: true, employeeCode: 'GG-7', department: 'Ops', company: 'c1', hours: { regular: 72, overtime: 3, doubleTime: 0, sick: 0, vacation: 0, personal: 0 } },
  { email: 'amando@x.com', name: 'Amando Lucero', approved: false, finalized: false, employeeCode: 'GG-9', department: 'Ops', company: 'c1', hours: { regular: 40, overtime: 0, doubleTime: 0, sick: 0, vacation: 0, personal: 0 } },
] };
vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getEntities: vi.fn(async () => [{ id: 'c1', name: 'Sample Co' }]),
    timeExportHours: vi.fn(async () => hours),
    timeExportIifFor: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'timeclock.iif' })),
    getStatementRules: vi.fn(async () => ({ rules: RULES })),
    createStatementRule: vi.fn(async (b) => ({ ...b, id: 'new' })),
    updateStatementRule: vi.fn(async (id, b) => ({ ...b, id })),
    deleteStatementRule: vi.fn(async () => ({ ok: true })),
    getAccountingAccounts: vi.fn(async () => ({ accounts: [{ account_no: '62000', title: 'Meals' }, { account_no: '40100', title: 'Interest Income' }] })),
    getAccountingPartners: vi.fn(async (kind) => ({ partners: kind === 'vendor' ? [{ id: 'V00037', name: 'AAA Insurance' }] : [{ id: 'C00010', name: 'Pat Tenant' }] })),
  },
}));
vi.mock('../../stepup/StepUp', () => ({ ensureStepUp: vi.fn(async () => ({ ok: true })), isStepUpRequired: () => false }));
const saved = vi.hoisted(() => []);
vi.mock('./reportModel', () => ({ downloadBlob: (name) => saved.push(name) }));
// DateField as a plain box (no native type="date" - UI test 10/23), so a test can type a date.
vi.mock('../../tasks/components', async (importOriginal) => ({ ...(await importOriginal()),
  DateField: ({ value, onChange, title }) => <input aria-label={title} data-datefield="1" value={value || ''} onChange={(e) => onChange(e.target.value)} /> }));

import { api } from '../../api';
import ImportHub from './ImportHub';

const REPORT = [
  ',,Dana Fox (E-0001),,,,,,TOTAL',
  ',,Hours,,Rate,,Amount,,Hours,,Rate,,Amount',
  'Hourly Wages,,10,,20.00,,200.00,,10,,,,200.00',
  'Federal Withholding,,,,,,-20.00,,,,,,-20.00',
  'Net Pay,,,,,,180.00,,,,,,180.00',
].join('\n');

describe('Import Hub', () => {
  beforeEach(() => { saved.length = 0; try { localStorage.clear(); } catch { /* none */ } });

  it('opens on the statement converter with the payroll tools beside it', () => {
    render(<ImportHub />);
    expect(screen.getByText('Upload a Statement')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ })).toBeTruthy();
  });

  it('loads every time sheet, names who is not finalized and keeps the IIF to the finalized ones (10/27 item 02)', async () => {
    api.timeExportIifFor.mockClear();
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ }));
    await screen.findByRole('option', { name: 'Sample Co' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Company' }), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load Hours' }));
    const table = await screen.findByRole('table', { name: 'Hours Preview' });
    // Everyone is loaded (never the finalized-only list that came back empty).
    expect(api.timeExportHours).toHaveBeenCalledWith(expect.any(String), expect.any(String), { company: 'c1', finalizedOnly: false });
    expect(within(table).getByText('Pat Lane')).toBeTruthy();
    expect(within(table).getByText('Finalized')).toBeTruthy();
    expect(within(table).getByText('Not Finalized - Left Out')).toBeTruthy();
    const note = screen.getByTestId('iif-unfinalized').textContent;
    expect(note).toMatch(/1 of 2 time sheets for \d\d\/\d\d\/\d{4} - \d\d\/\d\d\/\d{4} is not finalized yet: Amando Lucero\./);
    expect(note).toMatch(/The QuickBooks file has the 1 finalized one only\./);
    fireEvent.click(screen.getByRole('button', { name: /Download QuickBooks IIF/ }));
    await waitFor(() => expect(saved).toEqual(['timeclock.iif']));
    expect(api.timeExportIifFor.mock.calls[0][2]).toEqual({ company: 'c1', finalizedOnly: true, createTime: '' });
    fireEvent.click(screen.getByRole('button', { name: /Download Intacct Hours Import/ }));
    expect(saved[1]).toMatch(/^Intacct Hours Import - /);
  });

  it('includes the time sheets not finalized when asked, as a labeled draft', async () => {
    api.timeExportIifFor.mockClear();
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Hours' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Include Them' }));
    expect(screen.getByTestId('iif-unfinalized').textContent).toMatch(/includes 1 time sheet not finalized yet \(Amando Lucero\).*named DRAFT/);
    fireEvent.change(screen.getByLabelText('QuickBooks Company Create Time'), { target: { value: '12a34' } });
    fireEvent.click(screen.getByRole('button', { name: /Download Draft QuickBooks IIF/ }));
    await waitFor(() => expect(api.timeExportIifFor).toHaveBeenCalled());
    expect(api.timeExportIifFor.mock.calls[0][2]).toEqual({ company: '', finalizedOnly: false, createTime: '1234' });
    fireEvent.click(screen.getByRole('button', { name: 'Leave Them Out' }));
    expect(screen.getByRole('button', { name: /^Download QuickBooks IIF/ })).toBeTruthy();
  });

  it('says why when no time sheet is finalized, instead of an empty file', async () => {
    api.timeExportHours.mockResolvedValueOnce({ rows: hours.rows.map((r) => ({ ...r, finalized: false })) });
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Hours' }));
    expect((await screen.findByTestId('iif-unfinalized')).textContent).toMatch(/2 of 2 time sheets .* are not finalized yet: Pat Lane and Amando Lucero\. Without them the QuickBooks file would have nobody in it\./);
    expect(screen.getByTestId('iif-blocked').textContent).toMatch(/No time sheet in this period is finalized yet/);
    expect(screen.getByRole('button', { name: /Download QuickBooks IIF/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Include Them' }));
    expect(screen.getByRole('button', { name: /Download Draft QuickBooks IIF/ }).disabled).toBe(false);
    expect(screen.queryByTestId('iif-blocked')).toBeNull();
  });

  it('defaults to the last closed Nexus pay period', () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ }));
    const pick = screen.getByRole('combobox', { name: 'Pay Period' });
    // A real period (Sunday to Saturday, 14 days), never "Other Dates".
    expect(pick.value).toMatch(/^\d{4}-\d\d-\d\d\|\d{4}-\d\d-\d\d$/);
    const [start, end] = pick.value.split('|');
    expect(new Date(`${start}T12:00:00Z`).getUTCDay()).toBe(0);
    expect((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000).toBe(13);
    expect(screen.getByLabelText('Period Start').value).toBe(start);
  });

  it('turns a QuickBooks payroll report into a balanced Intacct import once the pay date is in', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    const file = new File([REPORT], 'payroll.csv', { type: 'text/csv' });
    file.text = async () => REPORT;   // jsdom's File has no text()
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText('Balanced')).toBeTruthy();
    const download = screen.getByRole('button', { name: /Download Intacct Payroll Import/ });
    expect(download.disabled).toBe(true);
    expect(screen.getByText('Pick the pay date.')).toBeTruthy();
    // The pay period boxes are the shared DateField, never a native date box.
    for (const l of ['Pay Date', 'Period Start', 'Period End']) expect(screen.getByLabelText(l).getAttribute('data-datefield')).toBe('1');
    expect(document.querySelector('input[type="date"]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Pay Date'), { target: { value: '2026-10-09' } });
    await waitFor(() => expect(download.disabled).toBe(false));
    fireEvent.click(download);
    expect(saved).toEqual(['payroll_intacct_payroll_import.csv']);
  });

  it('reads a QuickBooks Online Excel file past its empty first sheet (Priyanka, 10/22)', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'QuickBooks Desktop Export Tips');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['', '', '', '', 'Dana Fox(E-0001)', '', '', '', '', '', 'TOTAL'],
      ['', '', '', '', 'Hours', '', 'Rate', '', 'Oct 10 - 23, 26', '', 'Hours', '', 'Rate', '', 'Oct 10 - 23, 26'],
      ['', '', '', 'Hourly', '10', '', '20.00', '', '200.00', '', '10', '', '', '', '200.00'],
      ['', '', 'Federal Withholding', '', '', '', '', '', '-20.00', '', '', '', '', '', '-20.00'],
      ['Net Pay', '', '', '', '10', '', '', '', '180.00', '', '10', '', '', '', '180.00'],
      ['', 'Qualified OT Tracking', '', '', '', '', '', '', '0.00', '', '', '', '', '', '0.00'],
    ]), 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const file = new File([bytes], 'OSM Payroll .xlsx');
    file.arrayBuffer = async () => bytes;
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText('Balanced')).toBeTruthy();
    expect(screen.getByText(/Payroll Summary \(QuickBooks Online\) - 1 employees - Oct 10 - 23, 26/)).toBeTruthy();
    expect(screen.queryByText(/Map or ignore/)).toBeNull();
  });

  it('names the missing column when a payroll file cannot be read', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    const csv = 'Employee,Payroll Item,Hours\nDana Fox,Hourly,10\n';
    const file = new File([csv], 'payroll.csv', { type: 'text/csv' });
    file.text = async () => csv;
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText(/^payroll\.csv: No Amount column found\./)).toBeTruthy();
  });

  it('names the line of an amount it cannot read and holds the download (10/27 item 03)', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    const bad = REPORT.replace('-20.00,,,,,,-20.00', '-2O.00,,,,,,-20.00');
    const file = new File([bad], 'payroll.csv', { type: 'text/csv' });
    file.text = async () => bad;
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText(/Could not read an amount in the report: line 4, Federal Withholding for Dana Fox \(E-0001\) \("-2O\.00"\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pay Date'), { target: { value: '2026-10-09' } });
    expect(screen.getByRole('button', { name: /Download Intacct Payroll Import/ }).disabled).toBe(true);
  });

  it('says which line the columns were found on when nothing under them reads', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    const csv = 'Payroll Detail\n\nEmployee,Payroll Item,Amount\nDana Fox,,\n';
    const file = new File([csv], 'detail.csv', { type: 'text/csv' });
    file.text = async () => csv;
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText('detail.csv: Found the Employee, Payroll Item and Amount columns on line 3, but no line under it has all three filled in.')).toBeTruthy();
  });

  it('refuses a file that is not a spreadsheet in plain words', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /QuickBooks Payroll to Intacct/ }));
    const file = new File(['%PDF'], 'Payroll Summary.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('QuickBooks payroll file'), { target: { files: [file] } });
    expect(await screen.findByText(/^Payroll Summary\.pdf is not a spreadsheet\./)).toBeTruthy();
  });

  it('classifies statement lines by the team rules, flags the rest, filters by vendor and saves a line as a rule (10/27 item 01)', async () => {
    render(<ImportHub />);
    const csv = 'Date,Description,Amount\n10/01/2026,INTEREST PAYMENT,200.00\n10/02/2026,AAA INSURANCE AUTOPAY,-734.33\n10/03/2026,Coffee,-4.50\n';
    const file = new File([csv], 'bank.csv', { type: 'text/csv' });
    file.text = async () => csv;
    fireEvent.change(screen.getByLabelText('Statement file'), { target: { files: [file] } });
    const table = await screen.findByRole('table', { name: 'Preview' });
    await waitFor(() => expect(within(table).getByText('Rule: INTEREST PAYMENT')).toBeTruthy());
    expect(within(table).getByText('Rule: AAA INSURANCE')).toBeTruthy();
    expect(screen.getByLabelText('Account for line 1').value).toBe('40100');
    expect(screen.getByLabelText('Vendor for line 2').value).toBe('V00037');
    // The coffee line has no rule: flagged, and the download waits for it.
    expect(screen.getByTestId('unclassified').textContent).toMatch(/1 of 3 lines are not classified/);
    fireEvent.change(screen.getByPlaceholderText('e.g. 10100'), { target: { value: '10100' } });
    const download = screen.getByRole('button', { name: /Download Intacct Import/ });
    expect(download.disabled).toBe(true);
    expect(screen.getByText(/Still needed: an account for 1 unclassified line\./)).toBeTruthy();
    // Vendor filter: only the AAA line.
    fireEvent.change(screen.getByRole('combobox', { name: 'Vendor Filter' }), { target: { value: 'V00037' } });
    expect(within(table).queryByText('Coffee')).toBeNull();
    expect(within(table).getByText('AAA INSURANCE AUTOPAY')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    // Classify the coffee line on the line itself, then download.
    fireEvent.change(screen.getByLabelText('Account for line 3'), { target: { value: '62000' } });
    expect(screen.queryByTestId('unclassified')).toBeNull();
    expect(within(table).getByText('Set on the Line')).toBeTruthy();
    expect(download.disabled).toBe(false);
    fireEvent.click(download);
    expect(saved).toEqual(['bank_intacct_je_import.csv']);
    // Save as Rule: the form comes prefilled from the line and saves for the team.
    fireEvent.click(screen.getByRole('button', { name: 'Save line 3 as a rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Statement Rules' });
    expect(within(dialog).getByLabelText('Description Holds').value).toBe('Coffee');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Rule' }));
    await waitFor(() => expect(api.createStatementRule).toHaveBeenCalled());
    expect(api.createStatementRule.mock.calls[0][0]).toMatchObject({ matchText: 'Coffee', direction: 'out', amount: null, account: '62000', accountName: 'Meals' });
    expect(await within(dialog).findByText(/Rule added/)).toBeTruthy();
  });

  it('lists, edits and deletes the team rules', async () => {
    api.updateStatementRule.mockClear(); api.deleteStatementRule.mockClear();
    render(<ImportHub />);
    const csv = 'Date,Description,Amount\n10/01/2026,INTEREST PAYMENT,200.00\n';
    const file = new File([csv], 'bank.csv', { type: 'text/csv' });
    file.text = async () => csv;
    fireEvent.change(screen.getByLabelText('Statement file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Rules (2)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Statement Rules' });
    const list = within(dialog).getByRole('table', { name: 'Rules' });
    expect(within(list).getByText('INTEREST PAYMENT')).toBeTruthy();
    expect(within(list).getByText('61500 - Vendor AAA Insurance')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit rule INTEREST PAYMENT' }));
    fireEvent.change(within(dialog).getByLabelText('GL Account'), { target: { value: '40200' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rule' }));
    await waitFor(() => expect(api.updateStatementRule).toHaveBeenCalledWith('r1', expect.objectContaining({ account: '40200' })));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Delete rule AAA INSURANCE' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteStatementRule).toHaveBeenCalledWith('r2'));
  });
});
