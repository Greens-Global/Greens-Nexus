import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Payroll Readiness (Neil, Oct 17 2026): runs on demand, chips + a filtered
// list of who needs attention, each with a way to their Time Sheet; the
// payroll export WARNS (never blocks) when people are not ready; HR edits
// the thresholds.

const apiMock = vi.hoisted(() => ({ payrollReadiness: vi.fn(), payrollReadinessSettings: vi.fn(), payrollReadinessSaveSettings: vi.fn() }));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmMock(...a), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('../stepup/StepUp', () => ({
  isStepUpRequired: (e) => e?.status === 403,
  StepUpNeeded: ({ onVerified }) => <button type="button" onClick={onVerified}>Verify to view</button>,
}));
vi.mock('../tasks/components', () => ({
  Modal: ({ title, children, footer }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}));

import PayrollReadiness from './PayrollReadiness';
import { filterRows, issueLines, confirmExportReadiness } from '../lib/payrollReadiness';

const PERIOD = { start: '2026-09-20', end: '2026-10-03', monthStart: '2026-09-01', monthEnd: '2026-09-30' };
const ROWS = [
  { email: 'amy@greensglobal.com', name: 'Amy Test', department: 'Ops', company: 'Greens US', payType: 'hourly',
    periodStart: '2026-09-20', periodEnd: '2026-10-03', ready: false, varianceFlags: 0, anomalies: [],
    exceptions: [{ type: 'not_approved', blocking: true, label: 'Time Sheet not approved by the manager' },
                 { type: 'out_of_location', blocking: false, label: 'Punches out of location on 1 day - check the site on the Time Sheet' }],
    variance: [] },
  { email: 'raj@greensglobal.com', name: 'Raj Test', department: 'Ops', company: 'Greens US', payType: 'hourly',
    periodStart: '2026-09-20', periodEnd: '2026-10-03', ready: true, varianceFlags: 1, exceptions: [],
    variance: [{ metric: 'hours', flag: true, reason: 'Hours 100.0h vs. 80.0h last period (+25%)' },
               { metric: 'ot', flag: false, reason: 'Overtime 0.0h vs. 0.0h last period (+0.0h)' }],
    anomalies: [{ type: 'ot_jump', reason: 'Overtime up from 1.0h last period to 9.0h' }] },
  { email: 'lee@greensglobal.com', name: 'Lee Test', payType: 'fixed', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    ready: true, varianceFlags: 0, exceptions: [], variance: [], anomalies: [] },
];
const REPORT = { period: PERIOD, rows: ROWS, payHidden: false, generatedAt: '2026-10-17T16:00:00+00:00',
  summary: { people: 3, ready: 2, notReady: 1, withVariance: 1, withAnomalies: 1 } };

beforeEach(() => {
  apiMock.payrollReadiness.mockReset().mockResolvedValue(REPORT);
  apiMock.payrollReadinessSettings.mockReset().mockResolvedValue({
    company: '', settings: { variancePct: 25, varianceHours: 8, anomalyPct: 40, anomalyHours: 10, otJumpHours: 4, missingOutCount: 2 },
    limits: {}, override: false, canEdit: true, canEditDefault: true, companies: [{ id: 'gg-us', name: 'Greens US' }] });
  apiMock.payrollReadinessSaveSettings.mockReset().mockImplementation((b) => Promise.resolve({ company: b.company, settings: b.settings, override: !!b.company }));
  confirmMock.mockReset().mockResolvedValue(true);
});

describe('filterRows and issueLines', () => {
  it('filter by what is wrong and list blocking items first', () => {
    expect(filterRows(ROWS, 'all').map(r => r.name)).toEqual(['Amy Test', 'Raj Test']);
    expect(filterRows(ROWS, 'exceptions').map(r => r.name)).toEqual(['Amy Test']);
    expect(filterRows(ROWS, 'variance').map(r => r.name)).toEqual(['Raj Test']);
    expect(filterRows(ROWS, 'anomalies').map(r => r.name)).toEqual(['Raj Test']);
    expect(issueLines(ROWS[0]).map(l => l.kind)).toEqual(['exception', 'note']);
    expect(issueLines(ROWS[1]).map(l => l.kind)).toEqual(['variance', 'anomaly']);   // unflagged variance stays out
  });
});

describe('PayrollReadiness', () => {
  it('renders without loading anything until the check is run', () => {
    render(<PayrollReadiness onOpenTimecard={vi.fn()} />);
    expect(screen.getByText('Payroll Readiness')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run Check/ })).toBeTruthy();
    expect(apiMock.payrollReadiness).not.toHaveBeenCalled();
  });

  it('runs, shows the chips, filters, and opens a Time Sheet', async () => {
    const open = vi.fn();
    render(<PayrollReadiness onOpenTimecard={open} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Check/ }));
    await screen.findByText('Amy Test');
    expect(apiMock.payrollReadiness).toHaveBeenCalledWith('', false);
    expect(screen.getByText('09/20/2026 - 10/03/2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 Needs Attention/ })).toBeTruthy();
    expect(screen.getByText('Time Sheet not approved by the manager')).toBeTruthy();
    expect(screen.queryByText('Lee Test')).toBeNull();          // ready with nothing to say

    fireEvent.click(screen.getByRole('tab', { name: 'Variance' }));
    expect(screen.queryByText('Amy Test')).toBeNull();
    const raj = document.querySelector('[data-email="raj@greensglobal.com"]');
    expect(within(raj).getByText('Hours 100.0h vs. 80.0h last period (+25%)')).toBeTruthy();
    fireEvent.click(within(raj).getByRole('button', { name: /Open Time Sheet/ }));
    expect(open).toHaveBeenCalledWith('raj@greensglobal.com', '2026-09-20', 'hourly');

    // The arrows move a whole period and Refresh re-runs it fresh.
    fireEvent.click(screen.getByRole('button', { name: 'Previous Period' }));
    await waitFor(() => expect(apiMock.payrollReadiness).toHaveBeenLastCalledWith('2026-09-06', false));
    fireEvent.click(await screen.findByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(apiMock.payrollReadiness).toHaveBeenLastCalledWith('2026-09-20', true));
  });

  it('asks for the identity check instead of failing', async () => {
    apiMock.payrollReadiness.mockRejectedValueOnce({ status: 403 });
    render(<PayrollReadiness onOpenTimecard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Check/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify to view' }));
    await screen.findByText('Amy Test');
  });

  it('shows an error with a retry, never a blank panel', async () => {
    apiMock.payrollReadiness.mockRejectedValueOnce(new Error('Server down'));
    render(<PayrollReadiness onOpenTimecard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Check/ }));
    expect(await screen.findByText('Server down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Amy Test');
  });

  it('lets HR change and save the thresholds per company', async () => {
    render(<PayrollReadiness onOpenTimecard={vi.fn()} toastOk={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Check/ }));
    await screen.findByText('Amy Test');
    fireEvent.click(screen.getByRole('button', { name: /Thresholds/ }));
    const box = await screen.findByRole('dialog', { name: 'Payroll Readiness Thresholds' });
    const pct = await within(box).findByLabelText('Variance (%)');
    expect(pct.value).toBe('25');
    fireEvent.change(pct, { target: { value: '30' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.payrollReadinessSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ company: '', reset: false, settings: expect.objectContaining({ variancePct: 30 }) })));
  });

  it('hides the thresholds from the manager tier', async () => {
    apiMock.payrollReadiness.mockResolvedValue({ ...REPORT, payHidden: true });
    render(<PayrollReadiness onOpenTimecard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Check/ }));
    await screen.findByText('Amy Test');
    expect(screen.queryByRole('button', { name: /Thresholds/ })).toBeNull();
  });
});

describe('confirmExportReadiness', () => {
  it('warns when people in the exported dates are not ready, and lets the export go', async () => {
    expect(await confirmExportReadiness('2026-09-20', '2026-10-03')).toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(expect.stringMatching(/^1 person is not ready - export anyway\?/), expect.objectContaining({ confirmText: 'Export Anyway' }));
    confirmMock.mockResolvedValueOnce(false);
    expect(await confirmExportReadiness('2026-09-20', '2026-10-03')).toBe(false);
  });

  it('says nothing when everyone is ready, or when the check cannot run', async () => {
    apiMock.payrollReadiness.mockResolvedValueOnce({ ...REPORT, rows: ROWS.filter(r => r.ready) });
    expect(await confirmExportReadiness('2026-09-20', '2026-10-03')).toBe(true);
    apiMock.payrollReadiness.mockRejectedValueOnce(new Error('nope'));
    expect(await confirmExportReadiness('2026-09-20', '2026-10-03')).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
