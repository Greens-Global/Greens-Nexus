import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

// A reload lands back on the same card (Charmi, Oct 16): the manager's Payroll
// view reopens the employee and period that were open, not the first person
// on the list and the current period.

const timePayroll = vi.fn(() => Promise.resolve({ payType: 'hourly', email: 'amy@x.com', days: [], totals: {} }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 5, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => key === 'timePayroll' ? timePayroll
    : key === 'timeTeam' ? () => Promise.resolve({ rows: [{ email: 'aarav@x.com', name: 'Aarav Mehta' }, { email: 'amy@x.com', name: 'Amy Bolanos' }] })
    : () => Promise.resolve([]) });
  return { api, default: api };
});

afterEach(() => { cleanup(); sessionStorage.clear(); timePayroll.mockClear(); });

const mount = async () => {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  return render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
};

describe('the Payroll view after a reload', () => {
  it('reopens the employee and period that were open', async () => {
    sessionStorage.setItem('nexus.payroll.last', JSON.stringify({ email: 'amy@x.com', start: '2026-09-23', payType: 'hourly' }));
    await mount();
    await waitFor(() => expect(timePayroll).toHaveBeenCalled());
    expect(timePayroll.mock.calls[0].slice(0, 2)).toEqual(['amy@x.com', '2026-09-20']);
    expect(await screen.findByText('Deducted Time')).toBeTruthy();
    // Someone no longer on the list is not kept.
    cleanup();
    sessionStorage.setItem('nexus.payroll.last', JSON.stringify({ email: 'gone@x.com', start: '2026-09-23', payType: 'hourly' }));
    timePayroll.mockClear();
    await mount();
    await waitFor(() => expect(timePayroll).toHaveBeenCalledWith('aarav@x.com', expect.any(String), expect.any(String)));
  }, 20000);
});
