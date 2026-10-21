import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Pay period finder (Neil, Oct 21 2026): the period label opens a list of
// periods (current marked, 12 back, one ahead) and a Go to Date; the manager
// sidebar can be narrowed to people with missing punches.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const card = () => ({
  payType: 'hourly', email: 'emp@x.com', rate: 25, rateSet: true,
  days: [{ date: TODAY, workedMin: 480, rate: 25, segments: [
    { in: `${TODAY}T15:00:00`, out: `${TODAY}T23:00:00`, inId: 'p-in', outId: 'p-out', workedMin: 480, otMin: 0, amount: 200, category: '', breaks: [] },
  ] }],
  pendingRequests: [], punchMeta: {}, totals: { workedMin: 480, regMin: 480, otMin: 0, totalPay: 200 },
});

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'MGR@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'timePayroll' ? card()
        : key === 'timeTeam' ? { rows: [{ email: 'emp@x.com', name: 'Erin Employee' }, { email: 'gap@x.com', name: 'Gary Gap' }] }
        : key === 'timeTeamExceptions' ? [{ email: 'emp@x.com', name: 'Erin Employee', missing: 0, exceptions: 0 }, { email: 'gap@x.com', name: 'Gary Gap', missing: 2, exceptions: 0 }]
        : []),
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

async function open() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="emp@x.com" initialStart={TODAY} toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
  await screen.findByText('Deducted Time');
}

describe('pay period finder', () => {
  it('opens the list from the label, marks the current period, and jumps to a picked one', async () => {
    await open();
    const label = screen.getByRole('button', { name: 'Pick a pay period' });
    const before = label.textContent;
    expect(label.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(label);
    expect(screen.getByText('Select a Pay Period')).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(14);
    const checked = radios.filter(r => r.getAttribute('aria-checked') === 'true');
    expect(checked.length).toBe(1);
    expect(checked[0].textContent).toContain('(current)');
    expect(radios[1]).toBe(checked[0]);   // one future period above it
    fireEvent.click(radios[2]);   // the previous period
    expect(screen.queryByText('Select a Pay Period')).toBeNull();
    expect(label.textContent).not.toBe(before);
    expect(label.textContent).toContain(radios[2].textContent.slice(0, 10));
  }, 20000);

  it('narrows the sidebar to people with missing punches', async () => {
    await open();
    const box = await screen.findByLabelText('Only People With Missing Punches');
    expect(screen.getByText('Erin Employee')).toBeTruthy();
    fireEvent.click(box);
    expect(screen.queryByText('Erin Employee')).toBeNull();
    expect(screen.getByText('Gary Gap')).toBeTruthy();
  }, 20000);
});
