import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// "Sign Your Updated Time Sheet" in the Daily Briefing (11/05/2026) links to
// /timeclock/timesheet?start=<period>&type=<pay type>: my own Time Sheet must
// open on THAT period, not the current one, and drop the link afterwards.

const asked = [];
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 1, myEmail: 'me@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => (...a) => {
    if (key === 'timeMyPayroll') asked.push(a[0]);
    return Promise.resolve(key === 'timeMyPayroll' ? { payType: 'hourly', email: 'me@x.com', days: [], totals: {} } : []);
  } });
  return { api, default: api };
});

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

describe('my Time Sheet opened from the briefing', () => {
  it('opens the linked period and drops the link from the address', async () => {
    window.history.replaceState(null, '', '/timeclock/timesheet?start=2026-10-04&type=hourly');
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await waitFor(() => expect(asked).toContain('2026-10-04'));
    expect(window.location.search).toBe('');
  });
});
