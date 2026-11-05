import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatTimeTz } from '../lib/displayTz';

// The hourly card as SwipeClock punch pairs (Charmi / Visesh, Oct 20 -
// replaces the Oct 16 single row + Break row): a shift with a lunch is two
// rows, clock-in -> break start and break end -> clock-out, each with its own
// Punch hours, and the break as its own line between them (11/04/2026: its
// start under In, its end under Out, its length under Category). The shift's
// figures and its Edit / Add / Log read on its first row. Display only: the
// hours and the pay are the server's, unchanged.

const now = new Date();
// Today on the card's clock (California) - not the test machine's, which
// runs in UTC on CI and is a day ahead every evening Pacific time.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const at = (hm) => `${TODAY}T${hm}:00`;
const t = (hm) => formatTimeTz(at(hm));
// As the grid draws it (TimeText, 11/04/2026): "8:08" then " PM" in its own box.
const tw = (hm) => t(hm).replace(/(am|pm)$/i, (m) => `\u00a0${m.toUpperCase()}`);

// 15:48 -> 20:08, break 20:08 - 20:23, 20:23 -> 23:45: 4:20 + 3:22 = 7:42.
const ONE_BREAK = {
  in: at('15:48'), out: at('23:45'), inId: 'p-in', outId: 'p-out', workedMin: 462, otMin: 0, amount: 169.4, category: '',
  geo: 'in_fence', workSite: 'GSE',
  breaks: [{ start: at('20:08'), end: at('20:23'), min: 15, implicit: false, startId: 'p-bs', endId: 'p-be' }],
};
const card = (segments, extra = {}) => ({
  payType: 'hourly', email: 'emp@x.com', rate: 22, rateSet: true,
  days: [{ date: TODAY, workedMin: segments.reduce((a, s) => a + s.workedMin, 0), rate: 22, segments, ...extra.day }],
  punchMeta: {
    'p-in': { kind: 'in', at: at('15:48'), source: 'Mobile app', ip: '10.0.0.7', site: 'GSE', manual: false, clock: true },
    'p-bs': { kind: 'break_start', at: at('20:08'), source: 'Mobile app', manual: false, clock: true },
    'p-be': { kind: 'break_end', at: at('20:23'), source: 'Entered by a manager', manual: true, createdBy: 'Charmi Desai', createdAt: at('23:50') },
    'p-out': { kind: 'out', at: at('23:45'), source: 'Mobile app', manual: false, clock: true },
    ...extra.meta,
  },
  totals: { workedMin: 462, regMin: 462, otMin: 0, regPay: 169.4, totalPay: 169.4 },
});

let CARD = card([ONE_BREAK]);
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, myLevel: 4, myEmail: 'hr@x.com', myGrantedModules: new Map(), canAccessModule: () => true, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      (key === 'timePayroll' || key === 'timeMyPayroll') ? CARD
        : key === 'timeTeam' ? { rows: [{ email: 'emp@x.com', name: 'Nimi Patel' }] } : []),
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

async function open(c, { self = false } = {}) {
  CARD = c;
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  const utils = render(<QueryClientProvider client={new QueryClient()}>
    {self
      ? <PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} />
      : <PayrollTimecard initialEmail="emp@x.com" initialStart={TODAY} toastOk={() => {}} toastErr={() => {}} />}
  </QueryClientProvider>);
  await screen.findByText('Deducted Time');
  const { container } = utils;
  const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
  // the rows with punches; the break lines between them
  const worked = [...container.querySelectorAll('tr.ts-row')];
  const lines = [...container.querySelectorAll('tr.ts-brk')];
  return { ...utils, cells, worked, lines };
}

// Columns: 0 Date, 1 In, 2 Out, 3 Deducted Time, 4 Category, 5 Punch,
// 6 Day Total, 7 OT, 8 Location, 9 Pay Rate, 10 Wage, 11 the actions.
describe('a shift with a break on the Time Sheet', () => {
  it('reads as two punch pairs with a break line between, each row its own hours', async () => {
    const { container, cells, worked, lines } = await open(card([ONE_BREAK]));
    const heads = [...container.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toEqual(['Date', 'In', 'Out', 'Deducted Time', 'Category', 'Punch', 'Day Total', 'OT', 'Location', 'Pay Rate', 'Wage', 'Actions']);
    expect(worked).toHaveLength(2);
    // Row 1: clock-in -> break start; row 2: break end -> clock-out.
    expect(cells(worked[0])[1]).toContain(tw('15:48'));
    expect(cells(worked[0])[2]).toContain(tw('20:08'));
    expect(cells(worked[1])[0]).toBe('');           // the date only on the day's first row
    expect(cells(worked[1])[1]).toContain(tw('20:23'));
    expect(cells(worked[1])[2]).toContain(tw('23:45'));
    // Each row's own Punch hours, adding up to the shift's 7:42 - the day's
    // total on its first row.
    expect(cells(worked[0])[5]).toBe('4:20');
    expect(cells(worked[1])[5]).toBe('3:22');
    expect(cells(worked[0])[6]).toBe('7:42');
    expect(cells(worked[1])[6]).toBe('');
    // The shift's Wage once, on its first row.
    expect(cells(worked[0])[10]).toBe('$169.40');
    expect(cells(worked[1])[10]).toBe('');
    // The break as its own line between them: start under In, end under Out,
    // only its length under Category - never "unpaid".
    expect(lines).toHaveLength(1);
    const bl = cells(lines[0]);
    expect(bl[0]).toBe('Break');
    expect(bl[1]).toBe(tw('20:08'));
    expect(bl[2]).toBe(tw('20:23'));
    expect(bl[4]).toBe('15 min');
    expect(lines[0].textContent).not.toMatch(/unpaid/i);
    expect(worked[0].nextElementSibling).toBe(lines[0]);
    expect(lines[0].nextElementSibling).toBe(worked[1]);
  }, 20000);

  it('lines every time up: hours:minutes and AM / PM each in a box of their own', async () => {
    const { worked } = await open(card([ONE_BREAK]));
    const tm = worked[0].querySelector('td:nth-child(2) .ts-tm');
    expect(tm.querySelector('b').textContent).toBe(t('15:48').replace(/(am|pm)$/i, ''));
    expect(tm.querySelector('i').textContent).toBe(`\u00a0${t('15:48').slice(-2).toUpperCase()}`);
    // Every time has a dot or a spacer of the dot's width in front of it.
    for (const tr of worked) for (const td of [tr.children[1], tr.children[2]]) {
      expect(td.querySelector('.ts-tc > .ts-dot, .ts-tc > .ts-gsp')).toBeTruthy();
    }
  }, 20000);

  it('puts Edit, Add and Log on the shift\'s first row, and the break line fixes the break', async () => {
    const { container, worked, lines } = await open(card([ONE_BREAK]));
    const acts = worked[0].querySelector('td.ts-act');
    expect([...acts.querySelectorAll('button')].map(b => b.textContent.trim())).toEqual(['Edit', 'Add', 'Log']);
    expect(acts.querySelector('button').getAttribute('title')).toContain('Edit this shift');
    expect(worked[1].querySelector('td.ts-act').textContent).toBe('');
    // The break line itself opens the break fixer.
    const brk = lines[0].querySelector('button');
    expect(brk.getAttribute('aria-label')).toContain('Fix the start or end of this break');
    fireEvent.click(brk);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // A past day with no punches offers Add and the Log on its one quiet line.
    const empty = [...container.querySelectorAll('tr.ts-quiet')].find(tr => tr.textContent.includes('No punches'));
    if (empty) expect([...empty.querySelectorAll('td.ts-act button')].map(b => b.textContent.trim())).toEqual(['Add', 'Log']);
    // A day still ahead reads Upcoming with no Add (Neil, 11/04/2026).
    const ahead = [...container.querySelectorAll('tr.ts-quiet')].find(tr => tr.textContent.includes('Upcoming'));
    if (ahead) expect(ahead.querySelector('td.ts-act').textContent).toBe('');
  }, 20000);

  it('keeps each punch on its own cell: the manager-entered break end is bold with its provenance', async () => {
    const { worked } = await open(card([ONE_BREAK]));
    const inBtn = worked[0].querySelector('td:nth-child(2) button[title*="Clock-in at"]');
    expect(inBtn.getAttribute('title')).toContain('Mobile app · GSE · IP 10.0.0.7');
    expect(inBtn.getAttribute('aria-label')).toMatch(/^Clock-in /);
    const breakEnd = worked[1].querySelector('td:nth-child(2) button[title*="Break end at"]');
    expect(breakEnd).toBeTruthy();
    expect(breakEnd.getAttribute('title')).toContain('Entered by Charmi Desai on');
    expect(breakEnd.querySelector('span').style.fontWeight).toBe('800');
    // ...and the clock-taken break start on row 1's Out is not.
    const breakStart = worked[0].querySelector('td:nth-child(3) button[title*="Break start at"]');
    expect(breakStart.querySelector('span').style.fontWeight).not.toBe('800');
  }, 20000);

  // Miranda, Oct 20: she proposed a new break-end time, it saved, and the card
  // showed nothing - the row after a break blanked every pending field.
  it('shows a pending edit on a break punch, on the employee and the manager card', async () => {
    const meta = { 'p-be': { kind: 'break_end', at: at('20:23'), pendingAt: at('20:40'), editStatus: 'pending', editReason: 'clocked in too soon' },
      'p-bs': { kind: 'break_start', at: at('20:08'), pendingAt: at('20:05'), editStatus: 'pending', editReason: 'started earlier' } };
    for (const self of [true, false]) {
      const c = card([ONE_BREAK], { meta }); if (self) c.email = 'hr@x.com';
      const { worked } = await open(c, { self });
      const breakEnd = worked[1].querySelector('td:nth-child(2)');
      expect(breakEnd.textContent).toContain(tw('20:40'));
      expect(breakEnd.textContent).toContain('Pending');
      expect(breakEnd.querySelector('[title*="clocked in too soon"]')).toBeTruthy();
      const breakStart = worked[0].querySelector('td:nth-child(3)');
      expect(breakStart.textContent).toContain(tw('20:05'));
      // ...and the clock-in / clock-out, which have none, show none.
      expect(worked[0].querySelector('td:nth-child(2)').textContent).not.toContain('Pending');
      expect(worked[1].querySelector('td:nth-child(3)').textContent).not.toContain('Pending');
      if (!self) expect(breakEnd.querySelector('[aria-label="Approve this edited time"]')).toBeTruthy();
      cleanup();
    }
  }, 30000);

  it('splits a shift with two breaks into three rows and two break lines', async () => {
    const seg = { ...ONE_BREAK, workedMin: 447, breaks: [
      ONE_BREAK.breaks[0],
      { start: at('22:00'), end: at('22:15'), min: 15, implicit: false, startId: 'p-bs2', endId: 'p-be2' },
    ] };
    const { cells, worked, lines } = await open(card([seg], { meta: {
      'p-bs2': { kind: 'break_start', at: at('22:00') }, 'p-be2': { kind: 'break_end', at: at('22:15') } } }));
    expect(worked).toHaveLength(3);
    expect(lines).toHaveLength(2);
    expect(cells(worked[0])[5]).toBe('4:20');
    expect(cells(worked[1])[5]).toBe('1:37');
    expect(cells(worked[2])[5]).toBe('1:30');
    expect(cells(worked[0])[6]).toBe('7:27');
  }, 20000);

  it('shows a break the clock-out closed as a missing break end, no made-up time', async () => {
    const seg = { ...ONE_BREAK, workedMin: 260, breaks: [{ start: at('20:08'), end: at('23:45'), min: 217, implicit: true, startId: 'p-bs', endId: '' }] };
    const { cells, worked, lines } = await open(card([seg]));
    expect(worked).toHaveLength(2);
    expect(cells(worked[1])[1]).toBe('Missing');
    expect(cells(worked[1])[2]).toContain(tw('23:45'));
    expect(cells(worked[1])[5]).toBe('-');
    expect(cells(worked[0])[5]).toBe('4:20');
    expect(cells(lines[0])[2]).toBe('Not Ended');
    expect(lines[0].querySelector('[title*="never punched"]')).toBeTruthy();
    // ...and it is the first thing to fix.
    expect(screen.getByTestId('ts-strip').textContent).toContain('Break Not Ended');
  }, 20000);

  it('shows an auto-deducted lunch as a line, not as punch times', async () => {
    const seg = { ...ONE_BREAK, breaks: [], workedMin: 447, deductedMin: 30 };
    const { cells, worked, lines } = await open(card([seg]));
    expect(worked).toHaveLength(1);
    expect(cells(worked[0])[3]).toBe('−30m');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('Auto-Deducted 30 min');
  }, 20000);

  it('ends an open shift on the break start, then On Break', async () => {
    const seg = { ...ONE_BREAK, out: '', outR: '', outId: '', workedMin: 0, amount: 0, breaks: [], flags: ['missing_out'] };
    const c = card([seg]);
    delete c.punchMeta['p-be']; delete c.punchMeta['p-out'];
    const { cells, worked, lines } = await open(c);
    expect(worked).toHaveLength(1);
    expect(cells(worked[0])[2]).toContain(tw('20:08'));
    expect(lines).toHaveLength(1);
    expect(cells(lines[0])[1]).toBe(tw('20:08'));
    expect(lines[0].textContent).toContain('On Break');
  }, 20000);
});

describe('the punch-pair layout is display only', () => {
  it('keeps every shift, day and period total the server sent', async () => {
    const { workStretches } = await import('./PayrollTimecard');
    // Rounded clock-in / out with raw break punches, and a paid rest break:
    // the rows still add up to the shift's paid minutes exactly.
    const segs = [
      ONE_BREAK,
      { ...ONE_BREAK, inR: at('15:45'), outR: at('23:45'), workedMin: 475, breaks: [{ ...ONE_BREAK.breaks[0], paidMin: 10 }] },
      { ...ONE_BREAK, workedMin: 447, breaks: [ONE_BREAK.breaks[0], { start: at('22:00'), end: at('22:15'), min: 15, startId: 'b', endId: 'c' }] },
      { ...ONE_BREAK, workedMin: 0, flags: ['missing_out', 'auto_clock_out'] },
      { ...ONE_BREAK, breaks: [], workedMin: 447, deductedMin: 30 },
    ];
    for (const s of segs) {
      const rows = workStretches(s).filter(x => x.kind === 'work');
      expect(rows.reduce((a, x) => a + x.seg.workedMin, 0)).toBe(s.workedMin);
      // the pay figures stay on the shift, never split
      if (rows.length > 1) expect(rows.every(x => !x.seg.amount && !x.seg.otMin)).toBe(true);
    }
    // On screen: the day total, the footer and the wage are the server's.
    const { container } = await open(card([ONE_BREAK]));
    const foot = [...container.querySelectorAll('tfoot tr')[0].querySelectorAll('td')].map(td => td.textContent.trim());
    expect(foot[0]).toBe('Total Worked');
    expect(foot).toContain('7:42');
    expect(foot).toContain('$169.40');
  }, 20000);
});

describe('California meal flags', () => {
  const flagged = () => card([ONE_BREAK], { day: { meal: { chip: 'Meal Missed', label: 'No 30-minute meal break in a day over 5 hours' } } });

  it('are never shown to the employee on My Time Sheet', async () => {
    const c = flagged(); c.email = 'hr@x.com';
    await open(c, { self: true });
    expect(screen.queryByText(/Meal Missed/)).toBeNull();
    expect(screen.queryByText(/No 30-minute meal break/)).toBeNull();
  }, 20000);

  it('show for HR on the employee card', async () => {
    await open(flagged());
    // On the day's line, and grouped on the Needs Attention strip.
    expect(screen.getAllByText('Meal Missed').length).toBeGreaterThan(0);
    expect(screen.getByTestId('ts-strip').textContent).toContain('Meal Missed');
  }, 20000);
});
