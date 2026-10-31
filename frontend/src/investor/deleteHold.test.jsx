import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Hold to confirm in Investor Relations (Neil, Oct 30 2026): Delete in the
// deal / investor / commitment popup is a hold of HOLD_RECORD_MS with no
// window.confirm in front; the server's 409 comes back under the button.
const calls = vi.hoisted(() => ({
  getIrFunds: vi.fn(), getIrInvestors: vi.fn(), getIrCommitments: vi.fn(),
  deleteIrFund: vi.fn(), deleteIrInvestor: vi.fn(), deleteIrCommitment: vi.fn(),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve([])) }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => e }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

const { default: FundsTab } = await import('./FundsTab');
const { default: InvestorsTab } = await import('./InvestorsTab');
const { default: CommitmentsTab } = await import('./CommitmentsTab');
const { HOLD_RECORD_MS } = await import('../ui/HoldButton');

const FUND = { id: 'f1', name: 'Solar Fund I', status: 'raising', targetRaise: 0, committed: 0, investorCount: 0 };
const INVESTOR = { id: 'i1', displayName: 'Ana Cruz', entityType: 'individual', status: 'active', accreditedStatus: 'verified', kycStatus: 'cleared', totalCommitted: 0, fundCount: 0 };
const COMMIT = { id: 'c1', fundId: 'f1', investorId: 'i1', investorName: 'Ana Cruz', fundName: 'Solar Fund I', commitmentAmount: 50000, units: 1, subscriptionDate: '2026-10-01', status: 'pending' };

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.getIrFunds.mockResolvedValue([FUND]);
  calls.getIrInvestors.mockResolvedValue([INVESTOR]);
  calls.getIrCommitments.mockResolvedValue([COMMIT]);
});
afterEach(() => { vi.useRealTimers(); });

async function holdDelete() {
  const btn = await screen.findByRole('button', { name: 'Delete, press and hold' });
  vi.useFakeTimers();
  fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
  await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
}

describe('Investor Relations delete holds', () => {
  it('a deal deletes once the hold completes', async () => {
    calls.deleteIrFund.mockResolvedValue({ ok: true });
    render(<FundsTab />);
    fireEvent.click(await screen.findByText('Solar Fund I'));
    await holdDelete();
    expect(calls.deleteIrFund).toHaveBeenCalledTimes(1);
    expect(calls.deleteIrFund).toHaveBeenCalledWith('f1');
  });

  it('an investor with commitments is refused, and the reason shows under the button', async () => {
    calls.deleteIrInvestor.mockRejectedValue(new Error('Cannot delete an investor with commitments - remove them first'));
    render(<InvestorsTab />);
    fireEvent.click(await screen.findByText('Ana Cruz'));
    await holdDelete();
    expect(calls.deleteIrInvestor).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('Cannot delete an investor with commitments - remove them first');
  });

  it('a commitment deletes once the hold completes', async () => {
    calls.deleteIrCommitment.mockResolvedValue({ ok: true });
    render(<CommitmentsTab />);
    fireEvent.click(await screen.findByText('Ana Cruz', { selector: 'td' }));
    await holdDelete();
    expect(calls.deleteIrCommitment).toHaveBeenCalledTimes(1);
    expect(calls.deleteIrCommitment).toHaveBeenCalledWith('c1');
  });
});
