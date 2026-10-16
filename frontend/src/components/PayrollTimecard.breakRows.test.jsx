import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The hourly card as a SwipeClock-style grid (Oct 16): the shift is one
// In / Out row with the day's total in Hrs/day, and each break the person
// punched is its own Break row under it (start, end, length). Edit / Add sit
// right after the date. A punch a manager entered reads bold, and its hover
// tells where it came from.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const CARD = {
  payType: 'hourly', email: 'me@x.com', rate: 25, rateSet: true,
  days: [{ date: TODAY, workedMin: 475, rate: 25, segments: [
    { in: `${TODAY}T15:35:00`, out: `${TODAY}T23:35:00`, inId: 'p-in', outId: 'p-out', workedMin: 475, otMin: 0, amount: 197.92, category: '',
      breaks: [{ start: `${TODAY}T19:05:00`, end: `${TODAY}T20:10:00`, min: 65, implicit: false, startId: 'p-bs', endId: 'p-be' }] },
  ] }],
  punchMeta: {
    'p-in': { kind: 'in', at: `${TODAY}T15:35:12`, source: 'Mobile app', ip: '10.0.0.7', site: 'GSE', manual: false },
    'p-be': { kind: 'break_end', at: `${TODAY}T20:10:00`, source: 'Entered by a manager', manual: true, createdBy: 'Charmi Desai', createdAt: `${TODAY}T21:00:00` },
  },
  totals: { workedMin: 475, regMin: 475, otMin: 0, totalPay: 197.92 },
};

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 1, myEmail: 'me@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => () => Promise.resolve(key === 'timeMyPayroll' ? CARD : []) });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

describe('a shift with a break on the Time Sheet', () => {
  it('is a shift row and a Break row, with Edit / Add up front and the day total on the shift', async () => {
    const PayrollTimecard = (await import('./PayrollTimecard')).default;
    const { container } = render(<QueryClientProvider client={new QueryClient()}>
      <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
    </QueryClientProvider>);
    await screen.findByText('Hrs/day');
    const heads = [...container.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toEqual(['Date', 'Edit', 'In', 'Out', 'Deducted Time', 'Category', 'Hours', 'Hrs/day', 'OT', 'Loc', 'Pay Rate', 'Wage', 'Log']);
    const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    const worked = [...container.querySelectorAll('tr.pr-day-row')].filter(tr => cells(tr)[6] !== '-');
    expect(worked).toHaveLength(2);
    // The shift: clock-in to clock-out, 7:55 worked, the day's 7:55 and the wage.
    expect(cells(worked[0])[6]).toBe('7:55');
    expect(cells(worked[0])[7]).toBe('7:55');
    expect(cells(worked[0])[11]).toBe('$197.92');
    // The break under it: start, end and its length; nothing in the pay columns.
    expect(cells(worked[1])[0]).toBe('Break');
    expect(cells(worked[1])[6]).toBe('1:05');
    expect(cells(worked[1])[7]).toBe('-');
    expect(cells(worked[1])[11]).toBe('');
    expect(screen.queryByText(/Coffee/)).toBeNull();
    // The manager-entered break end reads bold, and the clock-in's hover says where it came from.
    const times = [...container.querySelectorAll('tr.pr-day-row button[title*="Clock-in at"], tr.pr-day-row button[title*="Break end at"]')];
    expect(times).toHaveLength(2);
    expect(times[0].getAttribute('title')).toContain('Mobile app · GSE · IP 10.0.0.7');
    expect(times[1].getAttribute('title')).toContain('Entered by Charmi Desai on');
    expect(times[1].querySelector('span').style.fontWeight).toBe('800');
    // An employee gets Add on the shift row and Edit (a fix request) on the break row.
    expect(worked[0].querySelector('td:nth-child(2)').textContent).toBe('Add');
    expect(worked[1].querySelector('td:nth-child(2)').textContent).toBe('Edit');
  }, 20000);
});
