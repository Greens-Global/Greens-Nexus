import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Time Sheet bonuses (Neil, Oct 22 2026): listed with why, added with a
// description and an amount, read-only on a locked card. The employee sees
// theirs read only - who added it, when and why (Oct 22: nothing hidden).

const add = vi.fn(() => Promise.resolve({ id: 'b2', reopened: true, signAgain: false }));
vi.mock('../api', () => ({ api: { timecardBonusAdd: (...a) => add(...a), timecardBonusRemove: () => Promise.resolve({}) } }));

import TimecardBonuses from './TimecardBonuses';

const card = { email: 'emp@x.com', bonuses: [{ id: 'b1', description: 'Referral', amount: 150, by: 'hr@x.com', byName: 'Hana HR', at: '2026-10-20T10:00:00' }] };
const fmtM = (n) => `$${Number(n).toFixed(2)}`;
afterEach(() => { cleanup(); add.mockClear(); });

describe('TimecardBonuses', () => {
  it('lists bonuses and adds one for the period', async () => {
    const onChanged = vi.fn();
    const toastOk = vi.fn();
    render(<TimecardBonuses card={card} periodStart="2026-10-11" fmtM={fmtM} showPay onChanged={onChanged} toastOk={toastOk} />);
    expect(screen.getByText('Referral')).toBeTruthy();
    expect(screen.getByText('+$150.00')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Add Bonus/ });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Bonus description'), { target: { value: 'Holiday cover' } });
    fireEvent.change(screen.getByLabelText('Bonus amount'), { target: { value: '75.5' } });
    fireEvent.click(btn);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(add).toHaveBeenCalledWith({ email: 'emp@x.com', date: '2026-10-11', description: 'Holiday cover', amount: 75.5 });
    // Already approved: the adder is told it goes back for approval and a new signature.
    expect(toastOk.mock.calls[0][0]).toMatch(/goes back to the manager to approve again, then to the employee to sign/);
  });

  it('is read-only when locked', () => {
    render(<TimecardBonuses card={card} periodStart="2026-10-11" locked fmtM={fmtM} showPay />);
    expect(screen.queryByRole('button', { name: /Add Bonus|Remove/ })).toBeNull();
  });

  it('shows the employee their bonus, read only, with who added it', () => {
    render(<TimecardBonuses card={card} self fmtM={fmtM} showPay />);
    expect(screen.getByText('Bonus Added for You')).toBeTruthy();
    expect(screen.getByText('Referral')).toBeTruthy();
    expect(screen.getByText('+$150.00')).toBeTruthy();
    expect(screen.getByText(/Added by Hana HR on 10\/20\/2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add Bonus|Remove/ })).toBeNull();
    cleanup();
    // No bonus: nothing on the employee's card.
    const { container } = render(<TimecardBonuses card={{ email: 'emp@x.com' }} self fmtM={fmtM} showPay />);
    expect(container.innerHTML).toBe('');
  });
});
