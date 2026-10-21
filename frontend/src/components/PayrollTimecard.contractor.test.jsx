import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Contractors (Oct 21) use the same fixed card with the same math - only the
// wording changes, and an Invoice card hangs under the review panel.

const START = '2026-10-01';
const base = {
  payType: 'fixed', email: 'ravi@x.com', periodStart: START, periodEnd: '2026-10-31', monthlySalary: 85000, currency: 'INR',
  days: [{ date: START, status: 'present', workedMin: 480, segments: [] }],
  totals: { workedMin: 480, monthlySalary: 85000, totalPay: 85000, missedFullDays: 0, missedHalfDays: 0, weekendDaysWorked: 0 },
  bands: { fullMin: 420, halfMin: 240 },
};
let CARD = base;

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 3, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false, hrTeam: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? CARD
        : key === 'timeTeam' ? { rows: [{ email: 'ravi@x.com', name: 'Ravi Kumar' }] } : []),
  });
  return { api, default: api };
});

afterEach(cleanup);

async function mount() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="ravi@x.com" initialStart={START} initialPayType="fixed" toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
}

describe('a contractor\'s fixed card', () => {
  it('reads Monthly Fee / Invoice Amount and shows the Invoice card', async () => {
    CARD = { ...base, contractor: true, invoice: { id: 'i1', number: 'INV-2026-0007', status: 'draft', amount: 85000, currency: 'INR', sentAt: null } };
    await mount();
    expect(await screen.findByText('Fixed fee')).toBeTruthy();
    expect(screen.getByText(/^Monthly fee$/i)).toBeTruthy();
    expect(screen.getByText(/^Invoice amount this month$/i)).toBeTruthy();
    expect(screen.queryByText(/Net pay/i)).toBeNull();
    expect(screen.getByText('Invoice INV-2026-0007 - ₹85,000.00 - Awaiting HR approval')).toBeTruthy();
    expect(screen.getByText('Preview PDF')).toBeTruthy();
  }, 20000);

  it('keeps the salary wording and no Invoice card for an employee', async () => {
    CARD = base;
    await mount();
    expect(await screen.findByText('Fixed salary')).toBeTruthy();
    expect(screen.getByText('Monthly salary')).toBeTruthy();
    expect(screen.getByText('Net pay this month')).toBeTruthy();
    expect(screen.queryByTestId('invoice-card')).toBeNull();
  }, 20000);
});
