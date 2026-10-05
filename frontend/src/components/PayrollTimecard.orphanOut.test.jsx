import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A clock-out with no clock-in (Oct 1): sign-off was blocked with "a
// clock-out with no clock-in" while the timecard showed nothing on that day.
// The server now sends it as a segment with no `in`; the card shows "Missing"
// on the in side, and clicking it opens the day editor to add the clock-in.

// The card opens on the CURRENT pay period, so the lone clock-out goes on the
// first day of whatever period it asks for - a fixed date fell out of view
// once that period passed (failed 10/05).
const cardFor = (start) => {
  const end = new Date(`${start}T12:00:00`); end.setDate(end.getDate() + 13);
  return {
    payType: 'hourly', email: 'me@x.com', name: 'Me', periodStart: start, periodEnd: end.toISOString().slice(0, 10),
    rate: 20, rateSet: true, overtimeRule: 'ca',
    days: [{
      date: start, weekStart: start, workedMin: 0, regMin: 0, otMin: 0, dtMin: 0, pay: 0,
      segments: [{ in: '', inR: '', out: `${start}T17:05:00`, outR: `${start}T17:05:00`, inId: '', outId: 'o1',
        workedMin: 0, flags: ['out_without_in'], breaks: [] }],
    }],
    totals: { regMin: 0, otMin: 0, dtMin: 0, workedMin: 0, totalPay: 0, missingPunches: 1, editedPunches: 0, pendingEdits: 0 },
  };
};

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 1, myGrantedModules: new Set(), canAccessModule: () => false, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (start) => Promise.resolve(key === 'timeMyPayroll' ? globalThis.__cardFor(start) : []),
  });
  return { api, default: api };
});

globalThis.__cardFor = cardFor;

describe('a clock-out with no clock-in', () => {
  it('shows Missing on the in side and opens the editor from it', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    render(<QueryClientProvider client={new QueryClient()}><PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} /></QueryClientProvider>);
    const missing = await screen.findByRole('button', { name: 'Missing' });
    expect(missing.getAttribute('title')).toMatch(/missing clock-in/);
    fireEvent.click(missing);
    expect(await screen.findByText(/reason/i)).toBeTruthy();
  }, 20000);
});
