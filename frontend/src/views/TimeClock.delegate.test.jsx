import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Delegate My Approvals lives on Workday > Time Off, collapsed by default
// (Neil, Oct 20) - no longer on Overview.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), myEmail: 'max@x.com' }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'approvalDelegationsMine' ? { canDelegate: true, delegations: [], covering: [] }
        : key === 'approvalDelegationOptions' ? { delegates: [], offRanges: [] }
          : key === 'timesheetReviewWaiting' ? { reviews: [] }
            : key === 'timeStatus' ? {} : []),
  });
  return { api, default: api };
});

const SLOW = 20000;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe('Delegate My Approvals on the Time Off tab', () => {
  it('renders collapsed, and opens to the off-only form', async () => {
    const TimeClock = (await import('./TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    const head = await screen.findByRole('button', { name: /Delegate My Approvals/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(await screen.findByText(/Available when you have approved time off/)).toBeTruthy();
  }, SLOW);
});
