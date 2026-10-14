import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Import Hub (Neil, 10/15): the three tool cards, the Payroll Hours card
// loading Nexus hours and downloading the QuickBooks IIF, and the
// QuickBooks Payroll card turning a report into a balanced Intacct import.

const hours = { rows: [{ email: 'pat@x.com', name: 'Pat Lane', approved: true, employeeCode: 'GG-7', department: 'Ops', company: 'c1', hours: { regular: 72, overtime: 3, doubleTime: 0, sick: 0, vacation: 0, personal: 0 } }] };
vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getEntities: vi.fn(async () => [{ id: 'c1', name: 'Sample Co' }]),
    timeExportHours: vi.fn(async () => hours),
    timeExportIifFor: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'timeclock.iif' })),
  },
}));
vi.mock('../../stepup/StepUp', () => ({ ensureStepUp: vi.fn(async () => ({ ok: true })), isStepUpRequired: () => false }));
const saved = vi.hoisted(() => []);
vi.mock('./reportModel', () => ({ downloadBlob: (name) => saved.push(name) }));

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

  it('loads approved Nexus hours for a company and downloads the QuickBooks IIF', async () => {
    render(<ImportHub />);
    fireEvent.click(screen.getByRole('tab', { name: /Payroll Hours to QuickBooks/ }));
    await screen.findByRole('option', { name: 'Sample Co' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Company' }), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load Hours' }));
    expect(within(await screen.findByRole('table', { name: 'Hours Preview' })).getByText('Pat Lane')).toBeTruthy();
    expect(api.timeExportHours).toHaveBeenCalledWith(expect.any(String), expect.any(String), { company: 'c1', approvedOnly: true });
    expect(screen.getByText('Approved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Download QuickBooks IIF/ }));
    await waitFor(() => expect(saved).toEqual(['timeclock.iif']));
    expect(api.timeExportIifFor.mock.calls[0][2]).toEqual({ company: 'c1', approvedOnly: true });
    fireEvent.click(screen.getByRole('button', { name: /Download Intacct Hours Import/ }));
    expect(saved[1]).toMatch(/^Intacct Hours Import - /);
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
    fireEvent.change(screen.getByLabelText('Pay Date'), { target: { value: '2026-10-09' } });
    await waitFor(() => expect(download.disabled).toBe(false));
    fireEvent.click(download);
    expect(saved).toEqual(['payroll_intacct_payroll_import.csv']);
  });
});
