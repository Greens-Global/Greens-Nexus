import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// My Schedule / Team > Shifts, 11/17/2026:
// - "Today" is the person's own day in the zone they work in (/roles/me
//   home_zone), not California's - an India-based person saw the Today mark
//   on yesterday until early afternoon.
// - The day card's header keeps Today whole: today's card drops the month and
//   the row wraps ("Mon 16 Nov Tod" in the Workday card's narrow columns).
// - What an action did is said beside the control, a failure in the error
//   color, and the next action replaces it.

const role = { myHomeZone: 'Asia/Kolkata' };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), prompt: vi.fn(), alert: vi.fn() } }));

const answers = {};
const calls = {};
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      (calls[key] ||= []).push(args);
      const a = answers[key];
      return typeof a === 'function' ? a(...args) : Promise.resolve(a === undefined ? null : a);
    },
  });
  return { api, default: api };
});

const MyShifts = (await import('./MyShifts')).default;

const sched = { shift: null, timeoff: [], holidays: [], timeZone: 'Asia/Kolkata', scheduled: [], teams: [] };
const CALL = { id: 'd1', groupName: 'Yard Crew', date: '2026-11-18', kind: 'cancel', status: 'active', outcome: 'cancelled', reason: '', headline: 'Day cancelled for weather (unpaid)', ackAt: '' };

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(answers)) delete answers[k];
  Object.assign(answers, {
    timeMySchedule: sched, timeSchedActuals: { cells: {} }, timeMyConfirmations: { pending: [] },
    weatherCallMine: { calls: [] }, shiftRequestsMine: { mine: [], incoming: [], openShifts: [], teammates: [], settings: {} },
    availabilityMine: { days: [] }, getPeopleDirectory: [], getRolesDirectory: [],
  });
  role.myHomeZone = 'Asia/Kolkata';
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const todayHead = () => [...document.querySelectorAll('[data-day-head]')].filter((h) => /Today/.test(h.textContent));

describe('MyShifts - today is the person\'s own day', () => {
  it('marks Tuesday for someone in India while California is still on Monday', async () => {
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));   // 8:30 AM Tuesday in India, 7:00 PM Monday in California
    render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    expect(todayHead().map((h) => h.textContent)).toEqual(['Tue 17Today']);
  });

  it('marks Monday for someone in California at that same moment', async () => {
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
    role.myHomeZone = 'America/Los_Angeles';
    render(<MyShifts />);
    await screen.findByRole('status', { name: 'Week summary' });
    expect(todayHead().map((h) => h.textContent)).toEqual(['Mon 16Today']);
  });
});

describe('MyShifts - the day card header', () => {
  it('keeps Today whole: its card drops the month and the row wraps instead of clipping', async () => {
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));   // Monday in India: today is the week's first card
    render(<MyShifts embedded />);
    await screen.findByRole('status', { name: 'Week summary' });
    const heads = [...document.querySelectorAll('[data-day-head]')];
    expect(heads).toHaveLength(7);
    expect(heads[0].textContent).toBe('Mon 16Today');           // no "Nov" squeezed between them
    heads.forEach((h) => expect(h.style.flexWrap).toBe('wrap'));
    // Every size in the header is on the type scale (11 is its smallest).
    heads.forEach((h) => [...h.querySelectorAll('span')].forEach((x) => expect([11, 13]).toContain(parseFloat(x.style.fontSize))));
    cleanup();
    // Another day's first card still names the month.
    vi.setSystemTime(new Date('2026-11-18T08:00:00Z'));
    render(<MyShifts embedded />);
    await screen.findByRole('status', { name: 'Week summary' });
    expect(document.querySelector('[data-day-head]').textContent).toBe('Mon 16Nov');
  });
});

describe('MyShifts - what an action did', () => {
  it('says a failed Acknowledge in the error color beside the weather call, and the next action replaces it', async () => {
    vi.setSystemTime(new Date('2026-11-17T08:00:00Z'));
    answers.weatherCallMine = { calls: [CALL] };
    answers.weatherCallAck = () => Promise.reject(new Error('Could not reach Nexus.'));
    render(<MyShifts />);
    const card = await screen.findByText('Day cancelled for weather (unpaid)');
    const ack = () => within(card.closest('[data-weather-call]')).getByRole('button', { name: /Acknowledge/ });
    fireEvent.click(ack());
    const line = await waitFor(() => { const el = document.querySelector('[data-flash="weather"]'); expect(el).toBeTruthy(); return el; });
    expect(line.textContent).toBe('Could not reach Nexus.');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.style.color).toContain('--color-red');
    expect(document.querySelector('[data-flash="week"]')).toBeNull();   // not the old line under the week
    // It sits right after the weather calls, above the week.
    expect(line.compareDocumentPosition(document.querySelector('[data-day-head]')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The next action speaks in its place.
    answers.weatherCallAck = { ok: true };
    fireEvent.click(ack());
    await waitFor(() => expect(document.querySelector('[data-flash="weather"]').textContent).toBe('Acknowledged. Your manager can see you saw it.'));
    const okLine = document.querySelector('[data-flash="weather"]');
    expect(okLine.getAttribute('role')).toBe('status');
    expect(okLine.style.color).toContain('--color-green');
  });
});
