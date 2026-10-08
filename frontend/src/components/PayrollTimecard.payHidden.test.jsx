import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The manager tier never sees pay (Pranshu, 10/06): the server strips every pay
// figure and sends payHidden. On a FIXED-salary card that must also take away
// the words that imply pay - the "No salary set" warning and the "Effect on
// pay" column (which would read "no change" on every day once the amounts are
// gone) - while the hours stay.

const START = '2026-10-01';
const CARD = {
  payType: 'fixed', payHidden: true, email: 'arnav@x.com', periodStart: START, periodEnd: '2026-10-31',
  days: [{ date: START, status: 'present', workedMin: 480, segments: [] }],
  totals: { workedMin: 480 }, bands: { fullMin: 420, halfMin: 240 },
};

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 3, myEmail: 'val@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false, hrTeam: true }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? CARD
        : key === 'timeTeam' ? { rows: [{ email: 'arnav@x.com', name: 'Arnav Kapoor' }] } : []),
  });
  return { api, default: api };
});

afterEach(cleanup);

describe('a fixed-salary card with pay hidden', () => {
  it('drops the salary warning and the Effect on pay column', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard initialEmail="arnav@x.com" initialStart={START} initialPayType="fixed" toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await screen.findByText('Fixed salary');
    expect(screen.queryByText(/No salary set/)).toBeNull();
    expect(screen.queryByText('Effect on pay')).toBeNull();
    expect(screen.queryByText('no change')).toBeNull();
    expect(screen.queryByText(/Salary:/)).toBeNull();
  }, 20000);
});
