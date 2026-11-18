import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Confidential time off (Sep 29): the requester can mark a request
// confidential, and a caller the server redacted it for sees the type
// ("Time off - Sick", Neil Sep 30) but no note, and no Approve/Decline -
// just who decides.

const calls = {};
const REDACTED = {
  id: 't1', email: 'amy@x.com', name: 'Amy Test', type: 'sick', startDate: '2026-11-16', endDate: '2026-11-16',
  startTime: '', endTime: '', note: '', status: 'pending', confidential: true, redacted: true,
  canDecide: false, reviewer: 'Valinda Test',
};
const PLAIN = { ...REDACTED, id: 't2', email: 'bo@x.com', name: 'Bo Test', type: 'vacation', note: 'Beach week',
  confidential: false, redacted: false, canDecide: true, reviewer: undefined };

vi.mock('../api', () => {
  const answers = {
    shiftRequestsInbox: { pending: [], recent: [], settings: {} },
    timeOffList: [],
    timeOffMine: [],
    timeOffTypes: { builtIn: ['vacation', 'sick', 'personal', 'other'], custom: [], requestsOn: true },
  };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      (calls[key] ||= []).push(args);
      const over = globalThis.__apiAnswers || {};
      return Promise.resolve(key in over ? over[key] : key in answers ? answers[key] : null);
    },
  });
  return { api, default: api };
});

// The shared confirm (ui/dialog) has no host in a unit test: answer it here.
const confirmAsk = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a), alert: vi.fn(), prompt: vi.fn(), undo: vi.fn() } }));

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  globalThis.__apiAnswers = {};
  confirmAsk.mockReset().mockResolvedValue(true);
});

describe('planner requests line', () => {
  // Team > Requests moved into Approvals (11/04/2026): a request someone else
  // decides is named on the planner with who decides it, never a decision;
  // its note never travels (Approvals itself only lists what is yours).
  it('names a confidential request with who decides it and no note', async () => {
    const { requestsInRange } = await import('./shifts/RequestsStrip');
    const items = requestsInRange({ pending: [], waitingOnPeer: [] }, [REDACTED, PLAIN], '2026-11-15', '2026-11-21');
    expect(items.map((i) => [i.key, i.wait])).toEqual([['time_off:t2', ''], ['time_off:t1', 'Waiting On Valinda Test']]);
    expect(JSON.stringify(items)).not.toContain('Beach week');
  });
});

// These import the whole TimeClock view; the first import can pass the 5 s
// default when the full suite runs in parallel.
const SLOW = 20000;

// Dates from tomorrow, never a fixed day: the form refuses a start in the past,
// so a fixed 11/16/2026 failed from 11/17 on (11/17/2026).
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const D1 = day(1), D2 = day(2);
// The date boxes are DateField, never a native date input (11/17/2026: that
// one follows the computer's region). Open the box's calendar and pick the
// day by its name, the way a person does.
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const pickDate = (box, iso) => {
  fireEvent.click(screen.getByTitle(box));
  fireEvent.click(within(document.querySelector('[data-nx-calendar]')).getByRole('button', { name: us(iso) }));
};

describe('request form', () => {
  it('sends confidential: true when the box is ticked', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    const box = await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    fireEvent.click(box);
    expect(document.querySelector('input[type="date"]')).toBeNull();   // no region-dependent date box
    pickDate('From', D1);
    expect(screen.getByTitle('From').textContent).toBe(us(D1));        // reads MM/DD/YYYY
    expect(screen.getByTitle('To').textContent).toBe(us(D1));          // To follows From
    pickDate('To', D1);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  Surgery follow-up ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(calls.timeOffCreate?.length).toBe(1));
    expect(calls.timeOffCreate[0][0]).toMatchObject({ type: 'personal', confidential: true, start_date: D1, note: 'Surgery follow-up' });
  }, SLOW);

  it('sends without a note - the Reason says why, the Note is optional (Neil, Oct 1)', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    expect(screen.queryByText(/optional/i)).toBeNull();
    pickDate('From', D1);
    pickDate('To', D2);
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(calls.timeOffCreate?.length).toBe(1));
    expect(calls.timeOffCreate[0][0]).toMatchObject({ type: 'personal', end_date: D2, note: '' });
  }, SLOW);
});

describe('request form dates (11/17/2026)', () => {
  it('will not offer a past day until Request for a Past Date is chosen, and locks To on a specific-hours request', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    const yesterday = us(day(-1));
    const cell = () => within(document.querySelector('[data-nx-calendar]')).queryByRole('button', { name: yesterday });
    fireEvent.click(screen.getByTitle('From'));
    // Yesterday is on the page only when it is in this month's grid (not on the 1st of a month that starts on a Sunday).
    if (cell()) expect(cell().disabled).toBe(true);
    fireEvent.click(screen.getByTitle('From'));   // close it again
    fireEvent.click(screen.getByRole('button', { name: 'Request for a Past Date' }));
    fireEvent.click(screen.getByTitle('From'));
    if (cell()) expect(cell().disabled).toBe(false);
    fireEvent.click(screen.getByTitle('From'));
    fireEvent.click(screen.getByRole('switch'));   // specific hours: one day only
    expect(screen.getByTitle('A specific-hours request is single-day only').disabled).toBe(true);
  }, SLOW);
});

describe('my requests (11/17/2026)', () => {
  const APPROVED = { id: 'm1', type: 'vacation', startDate: '2026-12-21', endDate: '2026-12-24', startTime: '', endTime: '', note: '', status: 'approved' };

  it('asks before cancelling approved leave, naming the dates - Keep It cancels nothing', async () => {
    globalThis.__apiAnswers = { timeOffMine: [APPROVED] };
    confirmAsk.mockResolvedValue(false);
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledTimes(1));
    expect(confirmAsk.mock.calls[0][0]).toMatch(/approved Vacation time off for 12\/21\/2026 - 12\/24\/2026/);
    expect(confirmAsk.mock.calls[0][1]).toMatchObject({ confirmText: 'Cancel Request', cancelText: 'Keep It' });
    expect(calls.timeOffCancel).toBeUndefined();
    // Confirmed: now it goes.
    confirmAsk.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(calls.timeOffCancel?.[0]).toEqual(['m1']));
  }, SLOW);

  it('a failed load says so with Try Again - never "No time-off requests yet."', async () => {
    const failed = Promise.reject(new Error('down'));
    failed.catch(() => {});
    globalThis.__apiAnswers = { timeOffMine: failed };
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    expect(await screen.findByText(/Couldn.t load your requests/)).toBeTruthy();
    expect(screen.queryByText('No time-off requests yet.')).toBeNull();
    globalThis.__apiAnswers = { timeOffMine: [APPROVED] };
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('12/21/2026 - 12/24/2026')).toBeTruthy();
    expect(screen.queryByText(/Couldn.t load your requests/)).toBeNull();
  }, SLOW);
});

describe('request form totals and types (Neil, Sep 30)', () => {
  it('counts specific hours in hours: 8:30 AM - 5:30 PM is 9 hours', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    pickDate('From', D1);
    pickDate('To', D1);
    fireEvent.click(screen.getByRole('switch'));
    const times = document.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '08:30' } });
    fireEvent.change(times[1], { target: { value: '17:30' } });
    expect(screen.getByText('9:00')).toBeTruthy();   // H:MM, never decimals (Neil, 11/04/2026)
    expect(screen.getByText('hours')).toBeTruthy();
  }, SLOW);

  it('picks the Reason from exactly five, in order, with icons (Neil, Oct 1)', async () => {
    // A company's saved custom reasons no longer reach the request form.
    globalThis.__apiAnswers = { timeOffTypes: { builtIn: ['vacation'], custom: ['Holiday', 'Off'], requestsOn: true } };
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reason: Personal' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Personal', 'Sick', 'Vacation', 'Medical Appointment']);
    fireEvent.click(screen.getByRole('option', { name: /Sick/ }));
    expect(screen.getByRole('button', { name: 'Reason: Sick' })).toBeTruthy();
  }, SLOW);

  it('has no year-at-a-glance panel on the Time Off tab', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByText('My Requests');
    expect(screen.queryByText(/at a Glance/)).toBeNull();
  }, SLOW);

  it("gives a company's own types their own icons, not one shared calendar (Oct 1)", async () => {
    const { reasonLook } = await import('../lib/timeOffReasons');
    const names = ['Approved Time Off', 'Off', 'Holiday', 'Parental Leave', 'Jury Duty', 'Bereavement Leave'];
    const icons = names.map((n) => reasonLook(n, n).Icon);
    expect(new Set(icons).size).toBe(names.length);
    // "Approved Time Off" is approved, not "off"; "Coffee Break" is not "off".
    expect(reasonLook('Approved Time Off').Icon).not.toBe(reasonLook('Off').Icon);
    expect(reasonLook('Coffee Break').Icon).not.toBe(reasonLook('Off').Icon);
    // Two unknown types still differ by color.
    expect(reasonLook('Sabbatical').color).not.toBe(reasonLook('Garden Leave').color);
  }, SLOW);
});
