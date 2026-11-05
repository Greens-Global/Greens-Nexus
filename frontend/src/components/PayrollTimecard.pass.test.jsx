import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Time Sheet pass (Neil, 11/04/2026): an hourly holiday reads as a day
// off with no pay, Hide Empty Days, the review mark beside each name, the
// arrow keys through the people, "changed since it was approved", and
// Approve and Next opening the next person still waiting.

const START = '2026-10-18';   // a pay period long over, so nothing reads Upcoming
const day = (date, segments = [], extra = {}) => ({ date, weekStart: date < '2026-10-25' ? '2026-10-18' : '2026-10-25', workedMin: segments.reduce((a, s) => a + s.workedMin, 0), rate: 20, segments, ...extra });
const SEG = { in: '2026-10-19T15:00:00', out: '2026-10-19T23:00:00', inId: 'a', outId: 'b', workedMin: 480, otMin: 0, amount: 160, category: 'Front Desk', breaks: [] };
const CARD = {
  payType: 'hourly', email: 'amy@x.com', rate: 20, rateSet: true, zoneKey: 'california',
  days: [day('2026-10-19', [SEG]), day('2026-10-21', [], { isHoliday: true, holidayName: 'Founders Day', holidayType: 'mandatory' })],
  punchMeta: { a: { kind: 'in', at: SEG.in, clock: true }, b: { kind: 'out', at: SEG.out, clock: true } },
  totals: { workedMin: 480, regMin: 480, otMin: 0, regPay: 160, totalPay: 160, holidayPay: 0, holidayDays: 1 },
  review: { status: 'not_submitted', canApprove: true, agreeBlocker: '', employeeEmail: 'amy@x.com', rounds: [], parties: [],
    changedDays: [{ date: '2026-10-19', before: 450, after: 480 }], changedSince: '2026-10-30T18:00:00' },
};
const TEAM = [
  { email: 'amy@x.com', name: 'Amy Lee' },
  { email: 'bo@x.com', name: 'Bo Park', review: { status: 'completed' } },
  { email: 'cy@x.com', name: 'Cy Ruiz', review: { status: 'with_manager' } },
];
const calls = vi.hoisted(() => []);
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      calls.push([key, ...args]);
      if (key === 'timePayroll') return Promise.resolve({ ...structuredClone(globalThis.__card), email: args[0] });
      if (key === 'timeTeam') return Promise.resolve({ rows: TEAM });
      return Promise.resolve([]);
    },
  });
  return { api, default: api };
});

const realMatchMedia = window.matchMedia;
beforeEach(async () => {
  calls.length = 0;
  globalThis.__card = CARD;
  (await import('./PayrollTimecard')).clearTimecardCache();
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

async function open() {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  const utils = render(<QueryClientProvider client={new QueryClient()}>
    <PayrollTimecard initialEmail="amy@x.com" initialStart={START} toastOk={() => {}} toastErr={() => {}} />
  </QueryClientProvider>);
  await screen.findByText('Deducted Time');
  return utils;
}

describe('the Time Sheet pass', () => {
  it('reads an hourly company holiday as a day off, with no pay', async () => {
    const { container } = await open();
    const row = container.querySelector('tr.ts-holi');
    expect(row.textContent).toContain('Founders Day - office closed, no work and no pay.');
    expect(row.querySelector('td.r').textContent).toBe('-');
    expect(container.textContent).not.toMatch(/paid holiday|Company holiday \(/);
  }, 20000);

  it('hides the empty days on request, keeping worked days and the holiday', async () => {
    const { container } = await open();
    expect([...container.querySelectorAll('tr.ts-quiet')].length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('Hide Empty Days'));
    await waitFor(() => expect(container.querySelectorAll('tr.ts-quiet')).toHaveLength(0));
    expect(container.querySelector('tr.ts-holi')).toBeTruthy();
    expect(container.querySelectorAll('tr.ts-row')).toHaveLength(1);
  }, 20000);

  it('marks where each person is in review, and says what changed since approval', async () => {
    const { container } = await open();
    expect(container.querySelector('.pr-sidebar [aria-label="Signed"]')).toBeTruthy();
    expect(container.querySelector('.pr-sidebar [aria-label="Waiting for Review"]')).toBeTruthy();
    expect(screen.getByTestId('ts-changed').textContent).toContain('Changed since it was approved on 10/30/2026');
    expect(screen.getByTestId('ts-changed').textContent).toContain('7:30 to 8:00');
    expect(container.querySelector('[data-ts-day="2026-10-19"] .ts-chg').textContent).toBe('Was 7:30, now 8:00');
  }, 20000);

  it('steps through the people with the arrow keys', async () => {
    await open();
    await screen.findByText('Bo Park');
    const before = calls.filter(c => c[0] === 'timePayroll').map(c => c[1]);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('timesheet-person').textContent).not.toContain('Amy Lee'));
    // ...and the next person's card was already being fetched in the background.
    expect(before.length).toBeGreaterThan(0);
  }, 20000);

  it('Approve and Next approves, then opens the next person still waiting for review', async () => {
    await open();
    await screen.findByText('Cy Ruiz');
    const btns = await screen.findAllByRole('button', { name: /Approve and Next/ });
    fireEvent.click(btns[btns.length - 1]);
    await waitFor(() => expect(calls.some(c => c[0] === 'timesheetReviewApprovePeriod' && c[1] === 'amy@x.com')).toBe(true));
    // Bo is signed already, so Cy is next.
    await waitFor(() => expect(screen.getByTestId('timesheet-person').textContent).toContain('Cy Ruiz'));
  }, 20000);

  it('leaves a rounded time alone when it is opened and closed unchanged', async () => {
    globalThis.__card = { ...CARD, rounding: { enabled: true },
      days: [day('2026-10-19', [{ ...SEG, in: '2026-10-19T15:02:00', inR: '2026-10-19T15:00:00' }])] };
    const { container } = await open();
    const btn = container.querySelector('tr.ts-row td:nth-child(2) .ts-edit-t');
    fireEvent.click(btn);
    const box = await screen.findByLabelText('Clock-in time');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    await new Promise(r => setTimeout(r, 30));
    expect(calls.some(c => c[0] === 'timeAdjustPunch')).toBe(false);
  }, 20000);

  it('saves a typed time once, even when Enter is followed by a blur', async () => {
    const { container } = await open();
    fireEvent.click(container.querySelector('tr.ts-row td:nth-child(2) .ts-edit-t'));
    const box = await screen.findByLabelText('Clock-in time');
    fireEvent.change(box, { target: { value: '730' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    await waitFor(() => expect(calls.filter(c => c[0] === 'timeAdjustPunch')).toHaveLength(1));
  }, 20000);

  it('offers Add Clock-Out on a shift with a break that never clocked out', async () => {
    const open1 = { ...SEG, out: '', outId: '', workedMin: 0, amount: 0, flags: ['missing_out'],
      breaks: [{ start: '2026-10-19T19:00:00', end: '2026-10-19T19:30:00', min: 30, implicit: false, startId: 'bs', endId: 'be' }] };
    globalThis.__card = { ...CARD, punchMeta: { ...CARD.punchMeta, bs: { kind: 'break_start', at: '2026-10-19T19:00:00' }, be: { kind: 'break_end', at: '2026-10-19T19:30:00' } },
      days: [day('2026-10-19', [open1])] };
    const { container } = await open();
    const first = container.querySelector('tr.ts-row');
    expect(first.querySelector('td.ts-act').textContent).toContain('Add Clock-Out');
    expect(first.querySelector('td.ts-act').textContent).not.toContain('Edit');
  }, 20000);

  it('leaves the arrow keys to the grid while it has focus', async () => {
    const { container } = await open();
    await screen.findByText('Bo Park');
    const grid = container.querySelector('.ts-grid-wrap');
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    await new Promise(r => setTimeout(r, 30));
    expect(screen.getByTestId('timesheet-person').textContent).toContain('Amy Lee');
  }, 20000);
});
