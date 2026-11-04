import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

beforeEach(() => { for (const k of Object.keys(calls)) delete calls[k]; globalThis.__apiAnswers = {}; });

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

describe('request form', () => {
  it('sends confidential: true when the box is ticked', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    const box = await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    fireEvent.click(box);
    const dates = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: '2026-11-16' } });
    fireEvent.change(dates[1], { target: { value: '2026-11-16' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  Surgery follow-up ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(calls.timeOffCreate?.length).toBe(1));
    expect(calls.timeOffCreate[0][0]).toMatchObject({ type: 'personal', confidential: true, start_date: '2026-11-16', note: 'Surgery follow-up' });
  }, SLOW);

  it('sends without a note - the Reason says why, the Note is optional (Neil, Oct 1)', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    expect(screen.queryByText(/optional/i)).toBeNull();
    const dates = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: '2026-11-16' } });
    fireEvent.change(dates[1], { target: { value: '2026-11-17' } });
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(calls.timeOffCreate?.length).toBe(1));
    expect(calls.timeOffCreate[0][0]).toMatchObject({ type: 'personal', end_date: '2026-11-17', note: '' });
  }, SLOW);
});

describe('request form totals and types (Neil, Sep 30)', () => {
  it('counts specific hours in hours: 8:30 AM - 5:30 PM is 9 hours', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    await screen.findByRole('checkbox', { name: /Keep this confidential/ });
    const dates = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: '2026-11-16' } });
    fireEvent.change(dates[1], { target: { value: '2026-11-16' } });
    fireEvent.click(screen.getByRole('switch'));
    const times = document.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '08:30' } });
    fireEvent.change(times[1], { target: { value: '17:30' } });
    expect(screen.getByText('9')).toBeTruthy();
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
