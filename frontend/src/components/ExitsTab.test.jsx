import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// People > Exits (Neil, Oct 27 2026; the tracker 11/14/2026): the list of
// leavers with where each exit stands, the one sheet with the California
// vacation payout and use-it-or-lose-it balances, and Mark Reviewed ->
// Generate PDF. A manager sees the tracker and the checklist only.

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
    reopenExitStatement: vi.fn(),
    exitItemOutcome: vi.fn(),
    exitMailboxHandover: vi.fn(),
    retryExitEgnyte: vi.fn(),
    getDocUrl: vi.fn(),
  },
}));

const { default: ExitsTab } = await import('./ExitsTab');

const chips = [{ key: 'package', label: 'Waiting On Erin', tone: 'warn' }, { key: 'checklist', label: 'Checklist 1/2', tone: 'warn' },
  { key: 'items', label: '1 To Return', tone: 'warn' }, { key: 'access', label: 'Access Ends 11/01', tone: 'neutral' },
  { key: 'reports', label: '2 Need A Manager', tone: 'warn' }, { key: 'settlement', label: 'Settlement Open', tone: 'neutral' }];
const exit = { employeeId: 'e1', email: 'erin@x.com', name: 'Erin Test', firstName: 'Erin', jobTitle: 'Site Lead', company: 'c1', companyName: 'Greens Test Co',
  lastDay: '2026-10-31', exitType: 'resignation', exitTypeLabel: 'Voluntary Resignation', stage: 'Leaving', source: 'separation',
  statementStatus: 'open', statementStatusLabel: 'Open', closed: false, scheduled: true, chips,
  package: { state: 'waiting_person', label: 'Waiting On Erin', status: 'sent' }, reportsToMove: 2 };
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
  list.mockReset().mockResolvedValue({ exits: [exit], canSeeMoney: true, today: '2026-10-24' });
  one.mockReset().mockResolvedValue({ statement: statement(), tracker: exit, checklist: statement().checklist, review: review0, canSeeMoney: true });
  review.mockReset().mockResolvedValue({});
  generate.mockReset().mockResolvedValue({});
});

describe('ExitsTab', () => {
  it('lists the leavers with where each stands, and opens the one sheet', async () => {
    render(<ExitsTab />);
    expect(await screen.findByText('In 7 days')).toBeTruthy();               // the Live accent while it is ahead
    expect(screen.getByText('Waiting On Erin')).toBeTruthy();
    expect(screen.getByText('2 Need A Manager')).toBeTruthy();
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText('Exit - Erin Test')).toBeTruthy();
    // The sheet's title shows before its statement loads (skeletons): wait
    // for the figures, not just the title - a slow CI runner caught the gap.
    expect(await screen.findByText(/16h 00m x \$20\.00 per hour = \$320\.00/)).toBeTruthy();
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
    one.mockResolvedValue({ statement: statement(false), tracker: exit, checklist: statement(false).checklist, review: review0, canSeeMoney: false });
    render(<ExitsTab />);
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText(/final settlement needs Pay & Benefits access/)).toBeTruthy();
    expect(screen.queryByText(/\$320\.00/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).toBeNull();
  });

  it('shows the error, never the empty line, when the list fails', async () => {
    list.mockRejectedValue(new Error('Server error'));
    render(<ExitsTab />);
    expect(await screen.findByText(/Could not load the exits/)).toBeTruthy();
    expect(screen.queryByText('Nobody is leaving right now.')).toBeNull();
  });

  it('offers Received and Mark Lost for an item still out when they left', async () => {
    const st = statement();
    st.items = { held: [{ name: 'Laptop', serial: 'SN-9', kind: 'Assigned', rowKind: 'assignment', rowId: 'A1', returnPending: true, pictureRequired: true }], closedAtLeft: 0 };
    one.mockResolvedValue({ statement: st, tracker: exit, checklist: st.checklist, review: review0, canSeeMoney: true });
    render(<ExitsTab />);
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText('Return Pending')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Received/ })).toBeTruthy();
    expect(screen.getAllByText('Mark Lost').length).toBeGreaterThan(0);
    // Close Exit is a hold, behind the pay grant.
    fireEvent.click(screen.getByRole('button', { name: 'Close Exit' }));
    expect(await screen.findByLabelText('Why the exit is closed')).toBeTruthy();
  });

  it('a manager sees the tracker and the checklist, never the settlement', async () => {
    list.mockResolvedValue({ exits: [{ ...exit, chips: chips.filter((c) => c.key !== 'settlement') }], canSeeMoney: false, managerView: true, today: '2026-10-24' });
    one.mockResolvedValue({ statement: null, tracker: exit, checklist: statement().checklist, review: null, canSeeMoney: false, managerView: true });
    render(<ExitsTab />);
    expect(await screen.findByText(/Your direct reports who are leaving/)).toBeTruthy();
    fireEvent.click(await screen.findByText('Erin Test'));
    expect(await screen.findByText(/1 of 2 steps done/)).toBeTruthy();
    expect(screen.queryByText('Final Settlement')).toBeNull();
    expect(screen.queryByText('Laptop')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send Separation Package/ })).toBeNull();
  });

  it('says so when nobody is leaving', async () => {
    list.mockResolvedValue({ exits: [], canSeeMoney: true });
    render(<ExitsTab />);
    expect(await screen.findByText('Nobody is leaving right now.')).toBeTruthy();
  });
});
