import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// No self-approval (Oct 19-20): a manager or HR who opens their OWN Time Sheet
// from People > Time gets no Edit / Add / Add Punch / Add Time / approve
// controls - the server refuses them (_refuse_own_time) - and a hint that
// their fixes go through a punch fix request from Workday. Anyone else's
// card keeps every control.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const card = (email) => ({
  payType: 'hourly', email, rate: 25, rateSet: true,
  days: [{ date: TODAY, workedMin: 480, rate: 25, segments: [
    { in: `${TODAY}T15:00:00`, out: `${TODAY}T23:00:00`, inId: 'p-in', outId: 'p-out', workedMin: 480, otMin: 0, amount: 200, category: '', breaks: [],
      outPendingAt: `${TODAY}T23:30:00`, outEditStatus: 'pending', outEditReason: 'Stayed late' },
  ] }],
  pendingRequests: [{ id: 'rq1', localDate: TODAY, action: 'add', punchKind: 'break_start', at: `${TODAY}T19:00:00`, reason: 'Lunch' }],
  punchMeta: {}, totals: { workedMin: 480, regMin: 480, otMin: 0, totalPay: 200 },
});

let target = 'mgr@x.com';
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'MGR@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? card(target)
        : key === 'timeTeam' ? { rows: [{ email: 'mgr@x.com', name: 'Mia Manager' }, { email: 'emp@x.com', name: 'Erin Employee' }] } : []),
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

async function open(email) {
  target = email;
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  const utils = render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail={email} initialStart={TODAY} toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
  await screen.findByText('Deducted Time');
  return utils;
}

describe('your own Time Sheet in People > Time', () => {
  it('hides Edit, Add, Add Time and the approve buttons, and says where fixes go', async () => {
    const { container } = await open('mgr@x.com');
    expect(screen.getByTestId('own-card-hint').textContent).toContain('send a punch fix request from Workday > Time Sheet');
    expect(screen.queryByRole('button', { name: /Add Time/ })).toBeNull();
    const editCol = [...container.querySelectorAll('tr.pr-day-row td:nth-child(2)')].map(td => td.textContent.trim());
    expect(editCol.every(t => t === '')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve this edited time' })).toBeNull();
    expect(container.querySelector('button[title*="Click to edit this punch time"]')).toBeNull();
  }, 20000);

  it("keeps every control on someone else's card", async () => {
    const { container } = await open('emp@x.com');
    expect(screen.queryByTestId('own-card-hint')).toBeNull();
    expect(screen.getByRole('button', { name: /Add Time/ })).toBeTruthy();
    const editCol = [...container.querySelectorAll('tr.pr-day-row td:nth-child(2)')].map(td => td.textContent.trim());
    expect(editCol.some(t => t.includes('Edit'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve this edited time' })).toBeTruthy();
    expect(container.querySelector('button[title*="Click to edit this punch time"]')).not.toBeNull();
  }, 20000);
});
