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
    // The inbox takes its data from the module (Shifts.jsx, useManagerInbox) since Oct 2026.
    const Inbox = (await import('./ShiftRequestsInbox')).default;
    render(<Inbox inbox={{ pending: [], recent: [], waitingOnPeer: [] }} timeoff={[REDACTED, PLAIN]} loading={false} error={null} onRetry={() => {}} />);
    expect(await screen.findByText('Valinda Test decides this request.')).toBeTruthy();
    expect(screen.getAllByText('Confidential').length).toBe(1);
    expect(screen.getByText(/Time Off · Sick/)).toBeTruthy();
    // The plain request keeps its type, note and buttons.
    expect(screen.getByText(/Time Off · Vacation/)).toBeTruthy();
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
      .toEqual(['Personal', 'Sick', 'Vacation', 'Unpaid', 'Medical Appointment']);
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
