import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Salary advances on the Time Sheet (Neil, Oct 29 2026): nobody asks for
// their own. On someone else's sheet the direct manager (or HR without the
// pay grant) sends a request to HR and HR with the pay grant grants it; the
// employee's own sheet lists their advances read-only; a viewer with nothing
// to see and nothing to ask sees nothing.

const person = vi.fn();
const askFor = vi.fn();
const decide = vi.fn();
vi.mock('../api', () => ({
  api: {
    personSalaryAdvances: (...a) => person(...a),
    askSalaryAdvanceFor: (...a) => askFor(...a),
    decideSalaryAdvance: (...a) => decide(...a),
    cancelSalaryAdvance: vi.fn(),
    paySalaryAdvance: vi.fn(),
    moveSalaryAdvanceInstallment: vi.fn(),
    setSalaryAdvanceSchedule: vi.fn(),
  },
}));

const { default: TimeSheetAdvances, AskAdvanceButton, useTimeSheetAdvances } = await import('./TimeSheetAdvances');

const adv = (over) => ({
  id: 'a1', email: 'amy@x.com', name: 'Amy Test', company: 'c1', amount: 500, currency: 'USD', reason: 'Car repair',
  installments: 2, status: 'requested', statusLabel: 'Requested', source: 'request', requestedBy: 'max@x.com',
  requestedByName: 'Max Test', requestedAt: '2026-10-27T10:00:00Z', decidedByName: '', decidedAt: '', decisionNote: '',
  paidOn: '', paidByName: '', paymentMethod: '', paymentRef: '', repaid: 0, balance: 0, scheduled: 0, schedule: [],
  history: [], createdAt: '2026-10-27T10:00:00Z', updatedAt: '', payVisible: true, canDecide: false, ...over,
});
const base = { email: 'amy@x.com', name: 'Amy Test', payCurrency: 'USD', advances: [], canAsk: '', maxInstallments: 24, payMethods: [] };

// The Time Sheet's two places: the toolbar button and the section below the card.
function Sheet({ email, self = false, me = 'max@x.com', toastOk = () => {} }) {
  const a = useTimeSheetAdvances(email);
  return (
    <div>
      {!self && <AskAdvanceButton adv={a} toastOk={toastOk} toastErr={() => {}} />}
      <TimeSheetAdvances adv={a} self={self} me={me} toastOk={toastOk} toastErr={() => {}} />
    </div>
  );
}

const fill = () => {
  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '500' } });
  fireEvent.change(screen.getByLabelText(/Repay Over/), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText(/What It Is For/), { target: { value: 'Car repair' } });
};

beforeEach(() => {
  person.mockReset();
  askFor.mockReset().mockImplementation(async (_e, b) => adv({ amount: b.amount, installments: b.installments, reason: b.reason }));
  decide.mockReset().mockImplementation(async () => adv({ status: 'approved', statusLabel: 'Approved' }));
});

describe('TimeSheetAdvances', () => {
  it("lets the direct manager send a request to HR from the report's Time Sheet", async () => {
    person.mockResolvedValue({ ...base, canAsk: 'request' });
    const toastOk = vi.fn();
    render(<Sheet email="amy@x.com" toastOk={toastOk} />);
    expect(person).toHaveBeenCalledWith('amy@x.com');
    fireEvent.click(await screen.findByRole('button', { name: /Ask For A Salary Advance/ }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send To HR' }));
    await waitFor(() => expect(askFor).toHaveBeenCalledWith('amy@x.com', { amount: 500, installments: 2, reason: 'Car repair', currency: 'USD' }));
    expect(toastOk).toHaveBeenCalledWith('Sent to HR - $500.00 for Amy Test');
    // The new request shows in the section below.
    expect(await screen.findByText('Salary Advances')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
  });

  it('gives HR with the pay grant the grant form, and the HR actions', async () => {
    person.mockResolvedValue({ ...base, canAsk: 'grant', advances: [adv({ canDecide: true })] });
    render(<Sheet email="amy@x.com" me="hana@x.com" />);
    fireEvent.click(await screen.findByRole('button', { name: /Grant A Salary Advance/ }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Grant Advance' }));
    await waitFor(() => expect(askFor).toHaveBeenCalledWith('amy@x.com', expect.objectContaining({ amount: 500 })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(decide).toHaveBeenCalled());
  });

  it('shows your own advances read-only, with the schedule, and no ask button', async () => {
    person.mockResolvedValue({ ...base, advances: [adv({
      status: 'repaying', statusLabel: 'Repaying', paidOn: '2026-10-01', repaid: 250, balance: 250, canDecide: false,
      schedule: [
        { id: 'i1', seq: 1, date: '2026-10-04', periodStart: '2026-10-04', periodEnd: '2026-10-17', amount: 250, deductedAmount: 250, status: 'deducted', carriedFrom: '', currency: 'USD' },
        { id: 'i2', seq: 2, date: '2026-10-18', periodStart: '2026-10-18', periodEnd: '2026-10-31', amount: 250, deductedAmount: 0, status: 'scheduled', carriedFrom: '', currency: 'USD' },
      ] })] });
    render(<Sheet email="amy@x.com" self me="amy@x.com" />);
    expect(await screen.findByText('Your Salary Advances')).toBeTruthy();
    expect(screen.getByText(/Paid out 10\/01\/2026/)).toBeTruthy();
    expect(screen.getByText(/Pay period 10\/04\/2026 - 10\/17\/2026/)).toBeTruthy();
    expect(screen.getByText('Repaid')).toBeTruthy();
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Salary Advance/ })).toBeNull();
    for (const name of ['Approve', 'Mark Paid Out', 'Change Schedule', 'Cancel Request', 'Move Later']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('renders nothing for a viewer with nothing to see and nothing to ask', async () => {
    person.mockResolvedValue(base);
    const { container } = render(<Sheet email="amy@x.com" />);
    await waitFor(() => expect(person).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('<div></div>');
  });

  it('renders nothing when the person endpoint refuses', async () => {
    person.mockRejectedValue(new Error('Not found'));
    const { container } = render(<Sheet email="amy@x.com" />);
    await waitFor(() => expect(person).toHaveBeenCalled());
    expect(container.innerHTML).toBe('<div></div>');
  });
});
