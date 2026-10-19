import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Paid leave balances (Oct 19 2026): the employee card, the request hint and
// HR's panel render, and the import sends what was pasted.

const leaveAdmin = vi.fn();
const leaveImport = vi.fn();
const leavePersonBalance = vi.fn();
vi.mock('../api', () => ({
  api: {
    leaveAdmin: (...a) => leaveAdmin(...a),
    leaveImport: (...a) => leaveImport(...a),
    leavePersonBalance: (...a) => leavePersonBalance(...a),
    leaveSetCutover: vi.fn(), leaveSavePolicies: vi.fn(), leaveAdjust: vi.fn(),
    leaveAssign: vi.fn(), leaveRecalculate: vi.fn(), leaveMyBalance: vi.fn(),
  },
}));

const { default: LeaveBalancesAdmin, LeaveBalanceCard, RequestBalanceHint, bucketOf, fmtLeave } = await import('./LeaveBalances');

const POLICY = { id: 'us-ca', name: 'US - California', unit: 'hours', hoursPerDay: 8, assigned: false };
const BAL = {
  live: true, cutover: '2026-09-01', policy: POLICY, startDate: '2024-06-01', employmentType: 'full_time',
  vacation: { method: 'per_hour', available: 12.77, upcoming: 8, pending: 0, accrualPerHour: 0.01923, grants: [], eligible: true },
  sick: { method: 'lump', available: 16, upcoming: 0, pending: 4, eligible: true, eligibleOn: '2024-08-30', expiresOn: '2026-12-31' },
};

beforeEach(() => {
  leaveAdmin.mockReset().mockResolvedValue({
    cutover: '2026-09-01', canSetup: true, defaults: ['us-ca', 'us-other', 'in', 'none'],
    policies: [{ ...POLICY, eligibleTypes: ['full_time'], sick: { method: 'lump', hours: 40, afterDays: 90 },
      vacation: { method: 'per_hour', baseHoursPerYear: 2080, tiers: [{ fromYears: 1, hoursPerYear: 40 }] } }],
    people: [{ email: 'alice@greensglobal.com', name: 'Alice Test', ...BAL }],
  });
  leaveImport.mockReset().mockResolvedValue({ imported: 1, errors: [] });
  leavePersonBalance.mockReset().mockResolvedValue({ ...BAL, canEdit: true, entries: [] });
});

describe('leave balances', () => {
  it('maps leave types to a balance', () => {
    expect(bucketOf('PTO')).toBe('vacation');
    expect(bucketOf('Medical Appointment')).toBe('sick');
    expect(bucketOf('1/2 Day')).toBe('');
    expect(fmtLeave(16, { unit: 'days', hoursPerDay: 8 })).toBe('2 days');
  });

  it('shows the employee card only once balances are live', () => {
    const { container, rerender } = render(<LeaveBalanceCard balance={{ live: false }} />);
    expect(container.textContent).toBe('');
    rerender(<LeaveBalanceCard balance={BAL} />);
    expect(screen.getByText('My Paid Time Off')).toBeTruthy();
    expect(screen.getByText('12.77 h')).toBeTruthy();
    expect(screen.getByText(/Use by 12\/31\/2026/)).toBeTruthy();
  });

  it('warns when a request is bigger than the balance', () => {
    render(<RequestBalanceHint balance={BAL} type="vacation" hours={8} />);
    expect(screen.getByText(/the part over your balance would be unpaid/)).toBeTruthy();
  });

  it('renders HR panel and imports pasted rows', async () => {
    render(<LeaveBalancesAdmin toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Alice Test');
    fireEvent.click(screen.getByText('Import Opening Balances'));
    fireEvent.change(screen.getByLabelText('Opening balances'), { target: { value: 'email,vacation,sick\nalice@greensglobal.com,32,16' } });
    fireEvent.click(screen.getByText('Import'));
    await waitFor(() => expect(leaveImport).toHaveBeenCalledWith({ unit: 'hours', rows: [{ email: 'alice@greensglobal.com', vacation: 32, sick: 16 }] }));
    fireEvent.click(screen.getByText('Alice Test'));
    await screen.findByText(/No changes yet/);
  });

  it('shows nothing to someone who is not HR', async () => {
    leaveAdmin.mockReset().mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const { container } = render(<LeaveBalancesAdmin />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
