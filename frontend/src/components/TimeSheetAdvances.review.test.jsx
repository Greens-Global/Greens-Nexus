// Oct 29 2026 review of the Time Sheet's salary advances. On a US clock:
// set before anything reads it (Vitest runs each file in its own process).
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const person = vi.fn();
const cancel = vi.fn();
vi.mock('../api', () => ({
  api: {
    personSalaryAdvances: (...a) => person(...a),
    cancelSalaryAdvance: (...a) => cancel(...a),
    askSalaryAdvanceFor: vi.fn(),
    decideSalaryAdvance: vi.fn(),
    paySalaryAdvance: vi.fn(),
    moveSalaryAdvanceInstallment: vi.fn(),
    setSalaryAdvanceSchedule: vi.fn(),
  },
}));

const { default: TimeSheetAdvances, useTimeSheetAdvances } = await import('./TimeSheetAdvances');

const adv = (over) => ({
  id: 'a1', email: 'amy@x.com', name: 'Amy Test', company: 'c1', amount: 80, currency: 'USD', reason: 'Rent help',
  installments: 1, status: 'requested', statusLabel: 'Requested', source: 'request', requestedBy: 'amy@x.com',
  requestedByName: 'Amy Test', requestedAt: '2026-10-27T10:00:00Z', decidedByName: '', decidedAt: '', decisionNote: '',
  paidOn: '', paidByName: '', paymentMethod: '', paymentRef: '', repaid: 0, balance: 0, scheduled: 0, schedule: [],
  history: [], createdAt: '2026-10-27T10:00:00Z', updatedAt: '', payVisible: true, canDecide: false, ...over,
});
const base = { email: 'amy@x.com', name: 'Amy Test', payCurrency: 'USD', advances: [], canAsk: '', maxInstallments: 24, payMethods: [] };

function Sheet({ email, self = false, me }) {
  const a = useTimeSheetAdvances(email);
  return <TimeSheetAdvances adv={a} self={self} me={me} toastOk={() => {}} toastErr={() => {}} />;
}

beforeEach(() => {
  person.mockReset();
  cancel.mockReset().mockImplementation(async () => adv({ status: 'canceled', statusLabel: 'Canceled' }));
});

// The words a reader sees, without the avatars' initials in between.
const said = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-avatar]').forEach((n) => n.remove()); return c.textContent.replace(/\s+/g, ' '); };

describe('Time Sheet salary advances (Oct 29 2026 review)', () => {
  it('lets the person cancel the request they made for themselves, on their own sheet', async () => {
    person.mockResolvedValue({ ...base, advances: [adv()] });
    render(<Sheet email="amy@x.com" self me="amy@x.com" />);
    expect(await screen.findByText('Your Salary Advances')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Request' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('a1', {}));
    expect(await screen.findByText('Canceled')).toBeTruthy();
  });

  it("gives no Cancel Request on your own sheet for a request someone else made", async () => {
    person.mockResolvedValue({ ...base, advances: [adv({ requestedBy: 'max@x.com', requestedByName: 'Max Test' })] });
    render(<Sheet email="amy@x.com" self me="amy@x.com" />);
    await screen.findByText('Your Salary Advances');
    expect(screen.queryByRole('button', { name: 'Cancel Request' })).toBeNull();
  });

  it('keeps HR\'s Cancel Request with its note', async () => {
    person.mockResolvedValue({ ...base, advances: [adv({ requestedBy: 'max@x.com', canDecide: true })] });
    render(<Sheet email="amy@x.com" me="hana@x.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Request' }));
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Advance' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('a1', { note: 'Duplicate' }));
  });

  it('shows the requested date on the US clock, not the UTC day', async () => {
    // 10/27/2026 8:30 PM in California is already 10/28 in UTC.
    person.mockResolvedValue({ ...base, advances: [adv({ requestedBy: 'max@x.com', requestedByName: 'Max Test',
      requestedAt: '2026-10-28T03:30:00Z' })] });
    render(<Sheet email="amy@x.com" me="max@x.com" />);
    expect(said(await screen.findByText(/Requested 10\/27\/2026 by/))).toBe('Requested 10/27/2026 by Max Test');
  });
});
