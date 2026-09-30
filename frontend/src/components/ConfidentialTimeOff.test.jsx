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
    timeOffTypes: { builtIn: ['vacation', 'sick', 'personal', 'unpaid', 'other'], custom: [], requestsOn: true },
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

describe('manager inbox', () => {
  it('shows a confidential request with its type, no note, and who decides it', async () => {
    globalThis.__apiAnswers = { timeOffList: [REDACTED, PLAIN] };
    const Inbox = (await import('./ShiftRequestsInbox')).default;
    render(<Inbox onClose={() => {}} />);
    expect(await screen.findByText('Valinda Test decides this request.')).toBeTruthy();
    expect(screen.getAllByText('Confidential').length).toBe(1);
    expect(screen.getByText('Time off · sick')).toBeTruthy();
    // The plain request keeps its type, note and buttons.
    expect(screen.getByText('Time off · vacation')).toBeTruthy();
    expect(screen.getByText('Beach week')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBe(1);
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
    // Every request says why (Sep 29): without a reason nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(screen.getByText('Add the reason for this time off.')).toBeTruthy());
    expect(calls.timeOffCreate).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Surgery follow-up ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Request$/ }));
    await waitFor(() => expect(calls.timeOffCreate?.length).toBe(1));
    expect(calls.timeOffCreate[0][0]).toMatchObject({ confidential: true, start_date: '2026-11-16', note: 'Surgery follow-up' });
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

  it('picks the type of time off from a list with icons', async () => {
    const TimeClock = (await import('../views/TimeClock')).default;
    render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Type of time off: Vacation' }));
    fireEvent.click(screen.getByRole('option', { name: /Sick/ }));
    expect(screen.getByRole('button', { name: 'Type of time off: Sick' })).toBeTruthy();
  }, SLOW);
});
