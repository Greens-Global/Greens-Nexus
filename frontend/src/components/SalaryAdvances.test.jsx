import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Workday > Salary Advance (Neil, Oct 27 2026): the card hides for someone
// with no option; the manager tier asks; HR approves from Manage; the
// repayment schedule and its status show on the advance.

const overview = vi.fn();
const request = vi.fn();
const decide = vi.fn();
vi.mock('../api', () => ({
  api: {
    getSalaryAdvances: (...a) => overview(...a),
    requestSalaryAdvance: (...a) => request(...a),
    decideSalaryAdvance: (...a) => decide(...a),
    grantSalaryAdvance: vi.fn(),
    cancelSalaryAdvance: vi.fn(),
    paySalaryAdvance: vi.fn(),
    moveSalaryAdvanceInstallment: vi.fn(),
    setSalaryAdvanceSchedule: vi.fn(),
    getPeopleDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const { default: SalaryAdvancesCard } = await import('./SalaryAdvances');

const adv = (over) => ({
  id: 'a1', email: 'amy@x.com', name: 'Amy Test', company: 'c1', amount: 500, currency: 'USD', reason: 'Car repair',
  installments: 2, status: 'requested', statusLabel: 'Requested', source: 'request', requestedBy: 'amy@x.com',
  requestedByName: 'Amy Test', requestedAt: '2026-10-27T10:00:00Z', decidedByName: '', decidedAt: '', decisionNote: '',
  paidOn: '', paidByName: '', paymentMethod: '', paymentRef: '', repaid: 0, balance: 0, scheduled: 0, schedule: [],
  history: [{ at: '2026-10-27T10:00:00Z', by: 'amy@x.com', byName: 'Amy Test', action: 'requested', label: 'Requested', note: 'Car repair' }],
  createdAt: '2026-10-27T10:00:00Z', updatedAt: '', ...over,
});
const base = { mine: [], hr: [], canRequest: false, canHr: false, show: false, payCurrency: 'USD', maxInstallments: 24, payMethods: [] };

beforeEach(() => {
  overview.mockReset();
  request.mockReset().mockImplementation(async (b) => adv({ amount: b.amount, installments: b.installments, reason: b.reason }));
  decide.mockReset().mockImplementation(async () => adv({ status: 'approved', statusLabel: 'Approved' }));
});

describe('SalaryAdvancesCard', () => {
  it('renders nothing for someone with no option, no advance and no HR role', async () => {
    overview.mockResolvedValue(base);
    const { container } = render(<SalaryAdvancesCard />);
    await waitFor(() => expect(overview).toHaveBeenCalled());
    expect(container.querySelector('[data-salary-advances]')).toBeNull();
  });

  it('lets the manager tier ask, and shows the advance', async () => {
    overview.mockResolvedValue({ ...base, show: true, canRequest: true });
    const flash = vi.fn();
    render(<SalaryAdvancesCard flash={flash} />);
    fireEvent.click(await screen.findByRole('button', { name: /Request Advance/ }));
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText(/Repay Over/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/What It Is For/), { target: { value: 'Car repair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to HR' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ amount: 500, installments: 2, reason: 'Car repair', currency: 'USD' }));
    expect(await screen.findByText('$500.00')).toBeTruthy();
    expect(flash).toHaveBeenCalledWith('Sent to HR for approval');
  });

  it('shows the repayment schedule of a paid-out advance', async () => {
    overview.mockResolvedValue({ ...base, show: true, mine: [adv({
      status: 'repaying', statusLabel: 'Repaying', paidOn: '2026-10-01', repaid: 250, balance: 250,
      schedule: [
        { id: 'i1', seq: 1, date: '2026-10-04', periodStart: '2026-10-04', periodEnd: '2026-10-17', amount: 250, deductedAmount: 250, status: 'deducted', carriedFrom: '', currency: 'USD' },
        { id: 'i2', seq: 2, date: '2026-10-18', periodStart: '2026-10-18', periodEnd: '2026-10-31', amount: 250, deductedAmount: 0, status: 'scheduled', carriedFrom: '', currency: 'USD' },
      ] })] });
    render(<SalaryAdvancesCard />);
    expect(await screen.findByText('Repaying')).toBeTruthy();
    expect(screen.getByText(/Balance \$250\.00/)).toBeTruthy();
    expect(screen.getByText('Pay period 10/04/2026 - 10/17/2026')).toBeTruthy();
    expect(screen.getByText('Repaid')).toBeTruthy();
    // The person never gets HR's buttons.
    expect(screen.queryByRole('button', { name: 'Move Later' })).toBeNull();
  });

  it('HR approves from Manage', async () => {
    overview.mockResolvedValue({ ...base, show: true, canHr: true, hr: [adv()] });
    render(<SalaryAdvancesCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Manage \(1\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('a1', { action: 'approve' }));
  });
});
