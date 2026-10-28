import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026): the
// card's credit / pool / Extra Time pieces, the Month-End Reconciliation
// panel, the claim and decision popups, the Extra Time queue and the
// Settings panel. The server prices everything; these only show and send.

const apiMock = vi.hoisted(() => ({
  extraTimeFile: vi.fn(), extraTimeEdit: vi.fn(), extraTimeWithdraw: vi.fn(), extraTimeDecide: vi.fn(),
  extraTimeQueue: vi.fn(), timeIndiaPolicyGet: vi.fn(), timeIndiaPolicySet: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));

import { ExtraTimeCell, ExtraTimeClaimModal, ExtraTimeDecideModal, ReconciliationPanel } from './ExtraTime';
import { reconRows, creditText, hm } from '../lib/extraTime';
import ExtraTimeQueue from './ExtraTimeQueue';
import IndiaContractorPolicySettings from './IndiaContractorPolicySettings';

const fmtM = (n) => `Rs ${Number(n || 0).toFixed(2)}`;
// Neil's month: 22 scheduled days, 7.5 h pool, 2 missing, 1 recovered by the round-up, 5 h Extra Time.
const RECON = { scheduledDays: 22, earnedHalves: 40, missingHalves: 4, poolMin: 450, recoveredHalves: 2, roundedUp: true,
  remainderMin: 180, unpaidHalves: 2, extraTimeMin: 300, extraTimePay: 2025, upcomingDays: 0 };
const XT = { multiplier: 1.35, hoursPerDay: 9, hourlyEquivalent: 300, rate: 405 };

beforeEach(() => { Object.values(apiMock).forEach((f) => f.mockReset()); });

describe('reconciliation lines', () => {
  it('reads Neil’s worked example', () => {
    expect(reconRows(RECON, XT, { totalPay: 58050 }, fmtM)).toEqual([
      ['Scheduled workdays', '22'],
      ['Credits earned (hours worked and paid leave)', '20 days'],
      ['Missing', '2 days'],
      ['Pool hours (excess and incomplete-day hours)', '7h 30m'],
      ['Half days recovered', '2 (the 3h 00m remainder rounded up)'],
      ['Unpaid days', '1 day'],
      ['Extra Time', '5h 00m x Rs 405.00 = Rs 2025.00'],
      ['Total', 'Rs 58050.00'],
    ]);
  });

  it('names a day’s credit', () => {
    expect(creditText({ dayKind: 'scheduled', credit: 'full' })).toBe('Full');
    expect(creditText({ dayKind: 'scheduled', credit: 'full', leaveHalves: 2 })).toBe('Full (Paid Leave)');
    expect(creditText({ dayKind: 'holiday', credit: 'holiday' })).toBe('Holiday');
    expect(creditText({ dayKind: 'weekend', credit: '' })).toBe('');
    expect(hm(90)).toBe('1h 30m');
  });

  it('renders the panel, without money for the manager tier', () => {
    const { rerender } = render(<ReconciliationPanel data={{ indiaPolicy: { reconciliation: RECON, extraTime: XT }, totals: { totalPay: 58050 } }} fmtM={fmtM} showPay />);
    expect(screen.getByTestId('month-end-reconciliation').textContent).toContain('Rs 58050.00');
    rerender(<ReconciliationPanel data={{ indiaPolicy: { reconciliation: RECON, extraTime: XT }, totals: {} }} fmtM={fmtM} showPay={false} />);
    expect(screen.getByTestId('month-end-reconciliation').textContent).not.toContain('Rs ');
    expect(screen.getByText('Half days recovered')).toBeTruthy();
  });
});

describe('the Extra Time column', () => {
  it('offers Claim Extra Time only on a day with hours to claim while filing is open', () => {
    const onClaim = vi.fn();
    const day = { date: '2026-11-07', dayKind: 'weekend', claimableMin: 300, future: false, claim: null };
    const { rerender } = render(<ExtraTimeCell fd={day} self filingOpen onClaim={onClaim} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim Extra Time' }));
    expect(onClaim).toHaveBeenCalledWith(day);
    rerender(<ExtraTimeCell fd={day} self filingOpen={false} onClaim={onClaim} />);
    expect(screen.queryByRole('button', { name: 'Claim Extra Time' })).toBeNull();
    rerender(<ExtraTimeCell fd={{ ...day, claimableMin: 0 }} self filingOpen onClaim={onClaim} />);
    expect(screen.queryByRole('button', { name: 'Claim Extra Time' })).toBeNull();
  });

  it('shows the claim and lets HR decide it', () => {
    const onDecide = vi.fn();
    const day = { date: '2026-11-07', dayKind: 'weekend', claimableMin: 180, extraMin: 180, extraPay: 1215,
      claim: { id: 'c1', status: 'approved', claimedMin: 300, approvedMin: 300 } };
    render(<ExtraTimeCell fd={day} self={false} canDecide onDecide={onDecide} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('5h 00m')).toBeTruthy();
    expect(screen.getByText('3h 00m paid')).toBeTruthy();    // the day's hours fell below what was approved
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onDecide).toHaveBeenCalled();
  });
});

describe('the popups', () => {
  it('files a claim with the hours prefilled and a required note', async () => {
    apiMock.extraTimeFile.mockResolvedValue({ id: 'c1', status: 'pending' });
    const onDone = vi.fn();
    render(<ExtraTimeClaimModal fd={{ date: '2026-11-07', dayKind: 'weekend', claimableMin: 300, claim: null }} onClose={() => {}} onDone={onDone} />);
    const submit = screen.getByRole('button', { name: 'Submit Claim' });
    expect(submit.disabled).toBe(true);                          // the note is required
    expect(screen.getByLabelText('Hours').value).toBe('5');
    fireEvent.change(screen.getByLabelText('What Was the Work'), { target: { value: 'Billing cutover' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Claim' }));
    await waitFor(() => expect(apiMock.extraTimeFile).toHaveBeenCalledWith({ date: '2026-11-07', minutes: 300, note: 'Billing cutover' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('approves fewer hours, and declines only with a reason', async () => {
    apiMock.extraTimeDecide.mockResolvedValue({});
    const fd = { date: '2026-11-07', claimableMin: 300, workedMin: 300,
      claim: { id: 'c1', status: 'pending', claimedMin: 300, approvedMin: 0, note: 'Billing cutover' } };
    render(<ExtraTimeDecideModal fd={fd} name="Priya Test" onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Decline' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve 4h 00m' }));
    await waitFor(() => expect(apiMock.extraTimeDecide).toHaveBeenCalledWith('c1', { decision: 'approve', minutes: 240 }));
  });
});

describe('the Extra Time queue', () => {
  it('lists what is waiting and opens the time sheet', async () => {
    apiMock.extraTimeQueue.mockResolvedValue({ pending: [{ id: 'c1', employeeEmail: 'priya@x.com', name: 'Priya Test', date: '2026-11-07',
      periodStart: '2026-11-01', status: 'pending', claimedMin: 300, approvedMin: 0, note: 'Billing cutover', createdAt: '2026-11-08T10:00:00Z', canDecide: true }],
    decided: [] });
    const onOpen = vi.fn();
    render(<ExtraTimeQueue onOpenTimecard={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Priya Test' }));
    expect(onOpen).toHaveBeenCalledWith('priya@x.com', '2026-11-01', 'fixed');
    expect(screen.getByText('11/07/2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decide' })).toBeTruthy();
  });

  it('says so when nothing is waiting', async () => {
    apiMock.extraTimeQueue.mockResolvedValue({ pending: [], decided: [] });
    render(<ExtraTimeQueue />);
    expect(await screen.findByText('No Extra Time is waiting on a decision.')).toBeTruthy();
  });
});

describe('Settings > Time & Pay > India Contractor Policy', () => {
  it('turns the switch off for a company and keeps its Policy Starts', async () => {
    const d = { mode: '', startDate: '2026-11-01', defaultStart: '2026-11-01', enabled: true, companyCountry: 'IN', hasOverride: false };
    apiMock.timeIndiaPolicyGet.mockResolvedValue(d);
    apiMock.timeIndiaPolicySet.mockResolvedValue({ ...d, mode: 'off', enabled: false, hasOverride: true });
    const onOverride = vi.fn();
    render(<IndiaContractorPolicySettings company="co-in" onOverride={onOverride} />);
    const sw = await screen.findByLabelText('India Contractor Policy');
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(apiMock.timeIndiaPolicySet).toHaveBeenCalledWith({ mode: 'off', startDate: '2026-11-01' }, 'co-in'));
    await waitFor(() => expect(onOverride).toHaveBeenLastCalledWith(true));
  });

  it('shows the default for every company with no switch', async () => {
    apiMock.timeIndiaPolicyGet.mockResolvedValue({ mode: '', startDate: '2026-11-01', defaultStart: '2026-11-01', enabled: null, companyCountry: '', hasOverride: false });
    render(<IndiaContractorPolicySettings />);
    expect(await screen.findByText('Policy Starts')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
