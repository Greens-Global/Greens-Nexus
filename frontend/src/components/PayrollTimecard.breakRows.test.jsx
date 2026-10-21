import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatTimeTz } from '../lib/displayTz';

// The hourly card as SwipeClock punch pairs (Charmi / Visesh, Oct 20 -
// replaces the Oct 16 single row + Break row): a shift with a lunch is two
// rows, clock-in -> break start and break end -> clock-out, each with its own
// Total Hours, and a thin break line between them. Edit and Add sit in the
// same two slots on every row. Display only: the hours and the pay are the
// server's, unchanged.

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const at = (hm) => `${TODAY}T${hm}:00`;
const t = (hm) => formatTimeTz(at(hm));

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
  // the rows with punches (an empty day reads '-' in In and Out)
  const worked = [...container.querySelectorAll('tr.pr-day-row')].filter(tr => cells(tr).slice(2, 4).some(x => x !== '-'));
  const lines = [...container.querySelectorAll('tr.pr-break-line')];
  return { ...utils, cells, worked, lines };
}

describe('a shift with a break on the Time Sheet', () => {
  it('reads as two punch pairs with a break line between, each row its own hours', async () => {
    const { container, cells, worked, lines } = await open(card([ONE_BREAK]));
    const heads = [...container.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toEqual(['Date', 'Edit', 'In', 'Out', 'Deducted Time', 'Category', 'Total Hours', 'Hrs/Day', 'OT', 'Loc', 'Pay Rate', 'Wage', 'Log']);
    expect(worked).toHaveLength(2);
    // Row 1: clock-in -> break start; row 2: break end -> clock-out.
    expect(cells(worked[0])[2]).toContain(t('15:48'));
    expect(cells(worked[0])[3]).toContain(t('20:08'));
    expect(cells(worked[1])[0]).toBe('');           // the date only on the day's first row
    // Row 2 has no merged cells of its own: Date, Edit, In, Out, Total Hours, Hrs/Day.
    expect(cells(worked[1])).toHaveLength(6);
    expect(cells(worked[1])[2]).toContain(t('20:23'));
    expect(cells(worked[1])[3]).toContain(t('23:45'));
    // Each row's own Total Hours, adding up to the shift's 7:42.
    expect(cells(worked[0])[6]).toBe('4:20');
    expect(cells(worked[1])[4]).toBe('3:22');
    // Hrs/Day: the first row points down, the last one has the day's total.
    expect(worked[0].querySelectorAll('td')[7].querySelector('[aria-label="continues below"]')).toBeTruthy();
    expect(cells(worked[1])[5]).toBe('7:42');
    // The shift's Wage once, merged down over both rows and the break line.
    expect(cells(worked[0])[11]).toBe('$169.40');
    expect(worked[0].querySelectorAll('td')[11].getAttribute('rowspan')).toBe('3');
    // The break line between them.
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain(`Break 15 min (${t('20:08')} - ${t('20:23')})`);
    expect(worked[0].nextElementSibling).toBe(lines[0]);
    expect(lines[0].nextElementSibling).toBe(worked[1]);
  }, 20000);

  it('puts Edit and Add in the same two slots on every row, empty days included', async () => {
    const { container, worked } = await open(card([ONE_BREAK]));
    for (const tr of worked) {
      const slots = tr.querySelectorAll('td:nth-child(2) [data-slot]');
      expect([...slots].map(s => s.getAttribute('data-slot'))).toEqual(['edit', 'add']);
      expect(slots[0].textContent).toBe('Edit');
      expect(slots[1].textContent).toBe('Add');
    }
    // Row 2 starts where the break ended: its Edit fixes the break.
    expect(worked[1].querySelector('[data-slot="edit"] button').getAttribute('title')).toContain('this break');
    expect(worked[0].querySelector('[data-slot="edit"] button').getAttribute('title')).toContain('Edit this shift');
    // A day with no punches keeps Add in the right-hand slot, under the others.
    const empty = [...container.querySelectorAll('tr.pr-day-row')].find(tr => tr.querySelector('td:nth-child(2) [data-slot="add"]') && !tr.querySelector('[data-slot="edit"] button'));
    expect(empty).toBeTruthy();
    expect(empty.querySelector('[data-slot="edit"]').textContent).toBe('');
    expect(empty.querySelector('[data-slot="add"]').textContent).toBe('Add');
  }, 20000);

  it('keeps each punch on its own cell: the manager-entered break end is bold with its provenance', async () => {
    const { worked } = await open(card([ONE_BREAK]));
    const inBtn = worked[0].querySelector('td:nth-child(3) button[title*="Clock-in at"]');
    expect(inBtn.getAttribute('title')).toContain('Mobile app · GSE · IP 10.0.0.7');
    const breakEnd = worked[1].querySelector('td:nth-child(3) button[title*="Break end at"]');
    expect(breakEnd).toBeTruthy();
    expect(breakEnd.getAttribute('title')).toContain('Entered by Charmi Desai on');
    expect(breakEnd.querySelector('span').style.fontWeight).toBe('800');
    // ...and the clock-taken break start on row 1's Out is not.
    const breakStart = worked[0].querySelector('td:nth-child(4) button[title*="Break start at"]');
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
      const breakEnd = worked[1].querySelector('td:nth-child(3)');
      expect(breakEnd.textContent).toContain(t('20:40'));
      expect(breakEnd.textContent).toContain('pending');
      expect(breakEnd.querySelector('[title*="clocked in too soon"]')).toBeTruthy();
      const breakStart = worked[0].querySelector('td:nth-child(4)');
      expect(breakStart.textContent).toContain(t('20:05'));
      // ...and the clock-in / clock-out, which have none, show none.
      expect(worked[0].querySelector('td:nth-child(3)').textContent).not.toContain('pending');
      expect(worked[1].querySelector('td:nth-child(4)').textContent).not.toContain('pending');
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
    expect(cells(worked[0])[6]).toBe('4:20');
    expect(cells(worked[1])[4]).toBe('1:37');
    expect(cells(worked[2])[4]).toBe('1:30');
    expect(cells(worked[2])[5]).toBe('7:27');
    expect(worked[0].querySelectorAll('td')[11].getAttribute('rowspan')).toBe('5');
  }, 20000);

  it('shows a break the clock-out closed as a missing break end, no made-up time', async () => {
    const seg = { ...ONE_BREAK, workedMin: 260, breaks: [{ start: at('20:08'), end: at('23:45'), min: 217, implicit: true, startId: 'p-bs', endId: '' }] };
    const { cells, worked, lines } = await open(card([seg]));
    expect(worked).toHaveLength(2);
    expect(cells(worked[1])[2]).toBe('Missing');
    expect(cells(worked[1])[3]).toContain(t('23:45'));
    expect(cells(worked[1])[4]).toBe('0:00');
    expect(cells(worked[0])[6]).toBe('4:20');
    expect(lines[0].textContent).toContain('the break end was never punched');
  }, 20000);

  it('shows an auto-deducted lunch as a line, not as punch times', async () => {
    const seg = { ...ONE_BREAK, breaks: [], workedMin: 447, deductedMin: 30 };
    const { cells, worked, lines } = await open(card([seg]));
    expect(worked).toHaveLength(1);
    expect(cells(worked[0])[4]).toBe('−30m');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('Auto-Deducted 30 min');
  }, 20000);

  it('ends an open shift on the break start, then On Break since', async () => {
    const seg = { ...ONE_BREAK, out: '', outR: '', outId: '', workedMin: 0, amount: 0, breaks: [], flags: ['missing_out'] };
    const c = card([seg]);
    delete c.punchMeta['p-be']; delete c.punchMeta['p-out'];
    const { cells, worked, lines } = await open(c);
    expect(worked).toHaveLength(1);
    expect(cells(worked[0])[3]).toContain(t('20:08'));
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain(`On Break since ${t('20:08')}`);
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
    expect(screen.getByText('Meal Missed')).toBeTruthy();
  }, 20000);
});
