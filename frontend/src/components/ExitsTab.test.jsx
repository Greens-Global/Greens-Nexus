import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// People > Exits (Neil, Oct 27 2026): the list of leavers, the statement with
// the California vacation payout and use-it-or-lose-it balances, and Mark
// Reviewed -> Generate PDF.

const list = vi.fn();
const one = vi.fn();
const review = vi.fn();
const generate = vi.fn();
vi.mock('../api', () => ({
  api: {
    exitStatements: (...a) => list(...a),
    exitStatement: (...a) => one(...a),
    reviewExitStatement: (...a) => review(...a),
    generateExitStatement: (...a) => generate(...a),
    closeExitStatement: vi.fn(),
    getDocUrl: vi.fn(),
  },
}));

const { default: ExitsTab } = await import('./ExitsTab');

const exit = { employeeId: 'e1', email: 'erin@x.com', name: 'Erin Test', jobTitle: 'Site Lead', company: 'c1', companyName: 'Greens Test Co',
  lastDay: '2026-10-31', exitType: 'resignation', exitTypeLabel: 'Voluntary Resignation', stage: 'Leaving', source: 'separation',
  statementStatus: 'open', statementStatusLabel: 'Open' };
const statement = (money = true) => ({
  employeeId: 'e1', email: 'erin@x.com', name: 'Erin Test', jobTitle: 'Site Lead', companyName: 'Greens Test Co', lastDay: '2026-10-31',
  exitTypeLabel: 'Voluntary Resignation', stage: 'Leaving', moneyShown: money,
  timesheet: { status: 'not_started', statusLabel: 'Not Submitted', periodStart: '2026-10-18', periodEnd: '2026-10-31', earlierOpen: [],
    link: { view: 'hr', sub: 'hr-time', timecard: 'erin@x.com', start: '2026-10-18', payType: 'hourly' } },
  finalPay: money ? { grossPay: 140, currency: 'USD' } : null,
  leave: { live: true, state: 'CA', hoursPerDay: 8, buckets: [
    { bucket: 'vacation', label: 'Vacation', hours: 16, days: 2, payout: 'Required By California Law' },
    { bucket: 'sick', label: 'Sick', hours: 8, days: 1, payout: 'Not Paid Out (Company Policy)' }],
  payouts: [{ bucket: 'vacation', label: 'Vacation Payout', flag: 'Required By California Law', hours: 16,
    ...(money ? { rate: 20, currency: 'USD', amount: 320 } : {}) }] },
  reimbursements: { owed: [{ id: 'r1', item: 'Monitor', statusLabel: 'Approved - To Pay', ...(money ? { amount: 75, currency: 'USD' } : {}) }], openCount: 0 },
  advances: { toRecover: [{ id: 'a1', paidOn: '2026-10-01', ...(money ? { amount: 100, repaid: 0, balance: 100, currency: 'USD' } : {}) }], notPaidOutCount: 0 },
  items: { held: [{ name: 'Laptop', serial: 'SN-9', kind: 'Assigned' }], closedAtLeft: 0 },
  checklist: { exists: true, done: 1, total: 2, overdue: 1, open: [{ title: 'Final pay', dueDate: '2026-10-30' }] },
  summary: money ? { owedToEmployee: { USD: 395 }, toRecover: { USD: 100 } } : { owedToEmployee: {}, toRecover: {} },
});
const review0 = { status: 'open', statusLabel: 'Open', reviewStale: false, history: [] };

beforeEach(() => {
  list.mockReset().mockResolvedValue({ exits: [exit], canSeeMoney: true });
  one.mockReset().mockResolvedValue({ statement: statement(), review: review0, canSeeMoney: true });
  review.mockReset().mockResolvedValue({});
  generate.mockReset().mockResolvedValue({});
});

describe('ExitsTab', () => {
  it('lists the leavers and opens the statement', async () => {
    render(<ExitsTab />);
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText('Final Settlement - Erin Test')).toBeTruthy();
    expect(screen.getByText(/16\.00 h x \$20\.00 per hour = \$320\.00/)).toBeTruthy();
    expect(screen.getAllByText('Required By California Law').length).toBeGreaterThan(0);
    expect(screen.getByText('Not Paid Out (Company Policy)')).toBeTruthy();
    expect(screen.getByText('Laptop')).toBeTruthy();
    expect(screen.queryByText(/pending policy/)).toBeNull();
    // Generate waits for the review.
    expect(screen.getByRole('button', { name: 'Generate PDF' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Reviewed' }));
    await waitFor(() => expect(review).toHaveBeenCalledWith('e1'));
  });

  it('hides money and the sign-off without the pay grant', async () => {
    one.mockResolvedValue({ statement: statement(false), review: review0, canSeeMoney: false });
    render(<ExitsTab />);
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText(/Amounts are hidden/)).toBeTruthy();
    expect(screen.queryByText(/\$320\.00/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).toBeNull();
  });

  it('says so when nobody is leaving', async () => {
    list.mockResolvedValue({ exits: [], canSeeMoney: true });
    render(<ExitsTab />);
    expect(await screen.findByText('Nobody is leaving right now.')).toBeTruthy();
  });
});
