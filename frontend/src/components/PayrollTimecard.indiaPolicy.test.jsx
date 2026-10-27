import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026): an
// in-scope card shows each day's credit, its pool hours and Extra Time, the
// Month-End Reconciliation, and no weekend pay; HR decides a claim on the card.

const START = '2026-11-01';
const day = (date, extra) => ({ date, status: 'present', workedMin: 540, isWeekend: false, future: false, deduct: 0, bonus: 0,
  dayKind: 'scheduled', credit: 'full', creditHalves: 2, poolMin: 0, claimableMin: 0, extraMin: 0, extraPay: 0, claim: null, ...extra });
const CARD = {
  payType: 'fixed', email: 'priya@x.com', periodStart: START, periodEnd: '2026-11-30', monthlySalary: 58725, currency: 'INR',
  contractor: true, invoice: null, dailyRate: 2700, extraTimeCanDecide: true,
  days: [{ date: '2026-11-07', workedMin: 300, segments: [] }],
  fixedDays: [
    day('2026-11-02', { workedMin: 0, status: 'absent', credit: 'none', creditHalves: 0, missingHalves: 2, recoveredHalves: 2 }),
    day('2026-11-03', { workedMin: 630, poolMin: 90, claimableMin: 90 }),
    day('2026-11-07', { workedMin: 300, status: 'weekend_worked', isWeekend: true, dayKind: 'weekend', credit: '', claimableMin: 300,
      extraMin: 300, extraPay: 2025, claim: { id: 'c1', status: 'pending', claimedMin: 300, approvedMin: 0, note: 'Billing cutover' } }),
  ],
  totals: { workedMin: 1470, monthlySalary: 58725, salaryForPeriod: 58725, totalPay: 58050, deduction: 2700, missedFullDays: 1,
    missedHalfDays: 0, weekendDaysWorked: 1, weekendBonus: 0, extraTimeMin: 300, extraTimePay: 2025 },
  bands: { fullMin: 480, halfMin: 240 },
  indiaPolicy: { applies: true, version: 'v1', frozen: false, extraTime: { multiplier: 1.35, hoursPerDay: 9, hourlyEquivalent: 300, rate: 405 },
    reconciliation: { scheduledDays: 21, earnedHalves: 38, missingHalves: 4, poolMin: 450, recoveredHalves: 2, roundedUp: true,
      remainderMin: 180, unpaidHalves: 2, extraTimeMin: 300, extraTimePay: 2025 } },
};

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false, hrTeam: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? CARD
        : key === 'timeTeam' ? { rows: [{ email: 'priya@x.com', name: 'Priya Test' }] } : []),
  });
  return { api, default: api };
});

afterEach(cleanup);

describe('an India contractor\'s card', () => {
  it('shows credits, the pool, Extra Time and the reconciliation - no weekend pay', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard initialEmail="priya@x.com" initialStart={START} initialPayType="fixed" toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    expect(await screen.findByTestId('month-end-reconciliation')).toBeTruthy();
    for (const h of ['Credit', 'Pool', 'Extra Time']) expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    expect(screen.getByText('Weekend Worked')).toBeTruthy();
    expect(screen.getByText('Recovered from the pool')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();                       // the 10.5 h day's pool hours
    expect(screen.queryByText(/Weekend pay/)).toBeNull();
    expect(screen.getByText(/Unpaid days after reconciliation/)).toBeTruthy();
    expect(screen.getByText(/^Extra Time \(5h 00m approved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(await screen.findByTestId('extra-time-decide')).toBeTruthy();
    expect(screen.getByText('Billing cutover')).toBeTruthy();
  }, 20000);
});
