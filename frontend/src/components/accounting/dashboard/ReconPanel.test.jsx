import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The reconciliation list's right-side panel (10/27): item 08 - an account's
// status and ledger lines for the month, Open Full, its report as a full page;
// item 09 - a loan's month reconciled in Nexus only, Mark Reconciled only at a
// 0.00 difference, Reopen for Accounting admins with a reason.

const api = vi.hoisted(() => ({
  searchAccountingLedger: vi.fn(),
  getLiabilityRecon: vi.fn(),
  saveLiabilityRecon: vi.fn(),
  reopenLiabilityRecon: vi.fn(),
}));
vi.mock('../../../api', () => ({ api }));
vi.mock('./DashContext', () => ({ useDash: () => ({ period: '2026-09', book: 'accrual', m: (v) => `$${Number(v).toFixed(2)}` }) }));
vi.mock('../../../tasks/components', () => ({ DateField: ({ value, onChange, disabled }) => <input aria-label="Statement Date" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} /> }));
vi.mock('../EntryDetail', () => ({ default: ({ entryNo }) => <div data-testid="entry">{entryNo}</div> }));
vi.mock('../drill', () => ({ requestReportDrill: vi.fn() }));
vi.mock('../../../investor/lib/upload', () => ({ uploadToSupabase: vi.fn(), safeFileName: (s) => s }));

import ReconPanel from './ReconPanel';
import { requestReportDrill } from '../drill';

const bank = { key: 'gl:a@34000', type: 'Bank', name: 'INK - F&M - 5446', entityCode: '34000', gl: '11336', thru: '2026-09-30', book: 9082.4, stmt: 9082.4, diff: 0, status: 'Reconciled', source: 'intacct', intacctRef: 'INK FM 5446', intacctMatch: 'gl' };
const loan = { key: 'loan:L1', type: 'Mortgage', name: 'F&M Mortgage', entityCode: '34000', gl: '25100', thru: null, book: -412345.67, stmt: -412345.67, diff: 0, status: 'Behind', source: null, liability: true };
const LINES = { total: 2, debit: 100, credit: 25.5, rows: [
  { line_id: 'l1', entry_id: 'e1', entry_no: 'IA-1001', entry_date: '2026-09-03', description: 'Interest', memo: 'Sep', debit: 100, credit: 0 },
  { line_id: 'l2', entry_id: 'e2', entry_no: 'IA-1002', entry_date: '2026-09-28', description: 'Fee', debit: 0, credit: 25.5 },
] };
const detail = (record = null, ledger = 412345.67) => ({ loan: { id: 'L1', lender: 'F&M Mortgage', entityCode: '34000', glAccount: '25100' }, period: '2026-09', asOf: '2026-09-30', ledgerBalance: ledger, difference: null, record, history: record ? [record] : [], log: [] });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.searchAccountingLedger.mockResolvedValue(LINES);
});

describe('ReconPanel - drill-down (item 08)', () => {
  it('shows the status and the month\'s ledger lines, MM/DD/YYYY, and opens the full report', async () => {
    const nav = vi.fn();
    render(<ReconPanel row={bank} entityName="Isha Kadakia" fullLink="rpt-bank-activity:11336:34000:2026-09-01:2026-09-30" onNavigate={nav} onClose={vi.fn()} />);
    expect(api.searchAccountingLedger).toHaveBeenCalledWith(expect.objectContaining({ account: '11336', location: '34000', from: '2026-09-01', to: '2026-09-30', book: 'accrual' }));
    expect(await screen.findByText('IA-1001')).toBeTruthy();
    expect(screen.getByText('09/03/2026')).toBeTruthy();
    expect(screen.getAllByText('09/30/2026').length).toBeGreaterThan(0);
    expect(screen.getByText(/matched on the GL account/)).toBeTruthy();
    // Viral's two-way open: Open Full on the panel, the report as a full page.
    expect(screen.getByRole('button', { name: /Open Full/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Bank Activity/ }));
    expect(nav).toHaveBeenCalledWith('rpt-bank-activity:11336:34000:2026-09-01:2026-09-30');
    // An entry number opens the journal entry.
    fireEvent.click(screen.getByRole('button', { name: 'IA-1002' }));
    expect(screen.getByTestId('entry').textContent).toBe('IA-1002');
  });

  it('opens Reports when the account has no activity report', async () => {
    render(<ReconPanel row={{ ...bank, type: 'Investment', key: 'holding:x' }} entityName="Isha Kadakia" onClose={vi.fn()} />);
    await screen.findByText('IA-1001');
    fireEvent.click(screen.getByRole('button', { name: /Open in Reports/ }));
    expect(requestReportDrill).toHaveBeenCalledWith(expect.objectContaining({ account: '11336', from: '2026-09-01', to: '2026-09-30', entity: '34000' }));
  });

  it('Escape closes the panel', async () => {
    const onClose = vi.fn();
    render(<ReconPanel row={bank} entityName="" onClose={onClose} />);
    await screen.findByText('IA-1001');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReconPanel - liability reconciliation (item 09)', () => {
  it('opens Mark Reconciled only at a 0.00 difference, and saves in Nexus', async () => {
    api.getLiabilityRecon.mockResolvedValue(detail());
    api.saveLiabilityRecon.mockResolvedValue({ record: {} });
    const onSaved = vi.fn();
    render(<ReconPanel row={loan} entityName="Isha Kadakia" canEdit onSaved={onSaved} onClose={vi.fn()} />);
    const box = await screen.findByLabelText('Statement Ending Balance');
    const mark = screen.getByRole('button', { name: 'Mark Reconciled' });
    fireEvent.change(box, { target: { value: '412,357.67' } });
    expect(screen.getByText('12.00')).toBeTruthy();
    expect(mark.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '412,345.67' } });
    expect(mark.disabled).toBe(false);
    api.getLiabilityRecon.mockResolvedValue(detail({ id: 'r1', period: '2026-09', status: 'reconciled', statementDate: '2026-09-30', statementBalance: 412345.67, difference: 0, reconciledBy: 'Charmi Desai', reconciledAt: '2026-10-27T12:00:00.000Z' }));
    await act(async () => { fireEvent.click(mark); });
    expect(api.saveLiabilityRecon).toHaveBeenCalledWith('L1', '2026-09', expect.objectContaining({ statementBalance: 412345.67, statementDate: '2026-09-30', reconcile: true }));
    await waitFor(() => expect(screen.getByText(/Reconciled by Charmi Desai on 10\/27\/2026/)).toBeTruthy());
    expect(onSaved).toHaveBeenCalled();
    // An editor cannot reopen.
    expect(screen.queryByRole('button', { name: 'Reopen Month' })).toBeNull();
  });

  it('lets an Accounting admin reopen, with a reason', async () => {
    api.getLiabilityRecon.mockResolvedValue(detail({ id: 'r1', period: '2026-09', status: 'reconciled', statementDate: '2026-09-30', statementBalance: 412345.67, difference: 0, reconciledBy: 'Charmi Desai', reconciledAt: '2026-10-27T12:00:00.000Z' }));
    api.reopenLiabilityRecon.mockResolvedValue({ record: {} });
    render(<ReconPanel row={loan} entityName="Isha Kadakia" canEdit canManage onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen Month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(api.reopenLiabilityRecon).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/why/i);
    fireEvent.change(screen.getByLabelText('Why Reopen'), { target: { value: 'Lender corrected it' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reopen' })); });
    expect(api.reopenLiabilityRecon).toHaveBeenCalledWith('L1', '2026-09', 'Lender corrected it');
  });

  it('is read only for a viewer', async () => {
    api.getLiabilityRecon.mockResolvedValue(detail());
    render(<ReconPanel row={loan} entityName="" onClose={vi.fn()} />);
    expect((await screen.findByLabelText('Statement Ending Balance')).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Mark Reconciled' })).toBeNull();
  });
});
