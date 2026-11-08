import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Salaried cards ride the same Time Sheet as hourly (Charmi, 11/06/2026: "push
// the updated time sheet template to everybody"): a US salary paid bi-weekly
// walks the 14-day period, a weekend day earns nothing extra (India only), and
// the phone gets the same day cards with the day's status.

const START = '2026-11-01';
const fd = (date, extra) => ({ date, status: 'present', workedMin: 480, isWeekend: false, deduct: 0, bonus: 0, leaveClass: '', timeOff: '', ...extra });
const seg = (date, inT, outT, min) => ({ id: `${date}-s`, in: `${date}T${inT}:00`, out: `${date}T${outT}:00`, inId: `${date}-i`, outId: `${date}-o`, workedMin: min, breaks: [] });
const CARD = {
  payType: 'fixed', periodKind: 'biweekly', email: 'valinda@x.com', periodStart: START, periodEnd: '2026-11-14',
  monthlySalary: 6000, currency: 'USD', dailyRate: 275.86, workingDaysInYear: 261, rateSet: true, weekendPay: false,
  days: [
    { date: '2026-11-01', workedMin: 27, weekStart: '2026-11-01', segments: [seg('2026-11-01', '20:50', '21:17', 27)] },
    { date: '2026-11-02', workedMin: 480, weekStart: '2026-11-01', segments: [seg('2026-11-02', '17:00', '23:59', 480)] },
  ],
  fixedDays: [
    fd('2026-11-01', { status: 'weekend_worked', isWeekend: true, workedMin: 27 }),
    fd('2026-11-02'),
    fd('2026-11-03', { status: 'absent', workedMin: 0, deduct: 275.86 }),
  ],
  totals: { workedMin: 507, monthlySalary: 6000, salaryForPeriod: 2769.23, totalPay: 2493.37, deduction: 275.86,
    missedFullDays: 1, missedHalfDays: 0, missedReasons: [{ reason: 'absent', label: 'Absent', full: 1, half: 0 }],
    weekendDaysWorked: 1, weekendBonus: 0 },
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
        : key === 'timeTeam' ? { rows: [{ email: 'valinda@x.com', name: 'Valinda Test' }] } : []),
  });
  return { api, default: api };
});

let PHONE = false;
const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: PHONE && /max-width:\s*900px/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; PHONE = false; });

async function mount() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  return render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="valinda@x.com" initialStart={START} initialPayType="fixed" toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
}

describe('a salaried card on the new Time Sheet', () => {
  it('a US bi-weekly salary: the 14-day period, the Day and Effect on Pay columns, no weekend pay', async () => {
    const { container } = await mount();
    expect(await screen.findByText('Salary this period (bi-weekly)')).toBeTruthy();
    const heads = [...container.querySelectorAll('.ts-grid thead th')].map(h => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(['Day', 'Effect on Pay', 'Day Total', 'Location']));
    expect(heads).not.toContain('OT');
    expect(heads).not.toContain('Wage');
    expect(container.querySelectorAll('.ts-grid tr.ts-first[data-ts-day]').length).toBe(14);   // 11/01 - 11/14, not the month
    expect(screen.getByText('Weekend Worked')).toBeTruthy();
    expect(screen.queryByText(/Weekend OT/)).toBeNull();
    expect(screen.queryByText(/Weekend pay/)).toBeNull();
    expect(screen.getByText('Net pay this period')).toBeTruthy();
    expect(screen.getByText(/paid bi-weekly/)).toBeTruthy();
    expect(screen.getByText('Missed Days')).toBeTruthy();                 // the chip strip
    expect(within(container.querySelector('tr[data-ts-day="2026-11-03"]')).getByText('Absent')).toBeTruthy();
  }, 20000);
  // The phone shows the week that holds today, so this test pins the clock
  // inside the fixture's first week (it broke on Sunday 11/08/2026 when
  // "today" moved into the second week).
  it('on a phone: day cards with the day status and the salary summary', async () => {
    PHONE = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 5, 12, 0, 0));
    try {
      const { container } = await mount();
      await screen.findByText('Net Pay');
      expect(container.querySelector('table.ts-grid')).toBeNull();
      const absent = container.querySelector('[data-ts-day="2026-11-03"]');
      expect(within(absent).getByText('Absent')).toBeTruthy();
      expect(within(container.querySelector('[data-ts-day="2026-11-01"]')).getByText('Weekend Worked')).toBeTruthy();
      expect(screen.queryByText('Est. Pay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 20000);
});
