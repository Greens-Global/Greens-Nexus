import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A time-tracking-exempt person is not on People > Time's roster
// (timeclock._in_roster), but HR still reaches their salary advances: the
// inbox / bell link {view:'hr', sub:'hr-time', timecard:<email>} opens their
// card by email (initialEmail is kept even when the roster leaves them out,
// and GET /time/payroll/{email} has no exempt check), and the card carries
// the Salary Advances section with HR's actions (Oct 29 2026 review).

const START = '2026-10-01';
const CARD = {
  payType: 'fixed', email: 'sal@x.com', periodStart: START, periodEnd: '2026-10-31', monthlySalary: 9000, currency: 'USD',
  days: [], totals: { workedMin: 0, monthlySalary: 9000, totalPay: 9000, missedFullDays: 0, missedHalfDays: 0, weekendDaysWorked: 0 },
  bands: { fullMin: 420, halfMin: 240 },
};
const APPROVED = {
  id: 'a1', email: 'sal@x.com', name: 'Sal Exempt', company: 'c1', amount: 1200, currency: 'USD', reason: 'Moving costs',
  installments: 2, status: 'approved', statusLabel: 'Approved', source: 'request', requestedBy: 'max@x.com',
  requestedByName: 'Max Test', requestedAt: '2026-10-20T17:00:00Z', decidedByName: 'Hana Test', decidedAt: '', decisionNote: '',
  paidOn: '', paidByName: '', paymentMethod: '', paymentRef: '', repaid: 0, balance: 0, scheduled: 0,
  schedule: [], history: [], createdAt: '', updatedAt: '', payVisible: true, canDecide: true,
};
const payroll = vi.fn();
const pay = vi.fn();

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hana@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false, hrTeam: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...a) => {
      if (key === 'timePayroll') { payroll(...a); return Promise.resolve(CARD); }
      if (key === 'paySalaryAdvance') { pay(...a); return Promise.resolve({ ...APPROVED, status: 'paid_out', statusLabel: 'Paid Out', paidOn: a[1].paid_on }); }
      return Promise.resolve(
        key === 'timeTeam' ? { rows: [{ email: 'amy@x.com', name: 'Amy Hourly' }] }   // the exempt person is not on it
          : key === 'personSalaryAdvances' ? { email: 'sal@x.com', name: 'Sal Exempt', canAsk: 'grant', payCurrency: 'USD', maxInstallments: 24, advances: [APPROVED] }
            : []);
    },
  });
  return { api, default: api };
});

afterEach(cleanup);

describe("HR and an exempt person's advances", () => {
  it('opens their card from the link and marks the advance Paid Out', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard initialEmail="sal@x.com" initialStart={START} initialPayType="fixed" toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    expect(await screen.findByText('Salary Advances')).toBeTruthy();
    expect(payroll.mock.calls.map((c) => c[0])).toContain('sal@x.com');
    expect(payroll.mock.calls.map((c) => c[0])).not.toContain('amy@x.com');
    expect(screen.getByRole('button', { name: /Grant A Salary Advance/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark Paid Out' }));
    const buttons = screen.getAllByRole('button', { name: 'Mark Paid Out' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(pay).toHaveBeenCalledWith('a1', expect.objectContaining({ payment_method: 'ach' })));
    expect(await screen.findByText('Paid Out')).toBeTruthy();
  }, 20000);
});
