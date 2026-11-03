import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// On the Schedule (Neil, 11/03/2026): a person row's menu has Take Off the
// Schedule (asked first, then an Undo that puts the opened slots back), and
// the grid's foot lists who is off with Put Back.

const role = { current: {} };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role.current }));
const api = {
  timeSchedule: vi.fn(), timeSchedConfirmations: vi.fn(), timeOffTypes: vi.fn(), timeSchedUnshared: vi.fn(),
  setOnSchedule: vi.fn(), undoOffSchedule: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || vi.fn().mockResolvedValue({}) }) }));
const confirmAsk = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a), prompt: vi.fn() } }));
vi.mock('../tasks/exporting', () => ({ exportExcel: vi.fn() }));

const ShiftSchedule = (await import('./ShiftSchedule')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = iso(new Date());
const us = (s) => { const [y, m, d] = s.split('-'); return `${m}/${d}/${y}`; };
const A = 'amy@x.com', B = 'bob@x.com';
const shift = (over) => ({ id: 's1', email: B, date: today, shiftId: 'p1', start: '09:00', end: '17:00', label: '', note: '', published: true,
  hasChanges: false, pendingDelete: false, openSlots: 0, code: 'GST', color: '#3b82f6', groupId: '', ...over });
function data(scheduled = [], over = {}) {
  return {
    employees: [{ email: A, name: 'Amy Adams' }, { email: B, name: 'Bob Brown' }],
    shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00', color: '#3b82f6', days: '1,2,3,4,5' }],
    groups: [], scheduled, timeoff: [], holidays: {}, canManage: true, timeZone: 'America/Los_Angeles', offSchedule: [], ...over,
  };
}
const toastOk = vi.fn();

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  role.current = {};
  Object.values(api).forEach((f) => f.mockReset());
  toastOk.mockReset();
  confirmAsk.mockReset().mockResolvedValue(true);
  api.timeOffTypes.mockResolvedValue({ builtIn: ['vacation'], custom: [], requestsOn: true });
  api.timeSchedConfirmations.mockResolvedValue({ people: [], unconfirmed: 0 });
  api.timeSchedUnshared.mockResolvedValue({ count: 0 });
});

describe('Take Off the Schedule', () => {
  it('asks with the shift count, calls the API, reloads and offers an Undo that puts the slots back', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()]));
    api.setOnSchedule.mockResolvedValue({ email: B, on: false, openedShiftIds: ['s1'], openedCount: 1 });
    api.undoOffSchedule.mockResolvedValue({ restored: 1, skipped: 0 });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Bob Brown');
    fireEvent.click(screen.getByLabelText('Options for Bob Brown'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Options for Bob Brown' })).getByText('Take Off the Schedule'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    expect(confirmAsk.mock.calls[0][0]).toBe(`Take Bob Brown off the schedule? Their 1 shift from ${us(today)} on becomes an open slot. You can put them back any time.`);
    await waitFor(() => expect(api.setOnSchedule).toHaveBeenCalledWith(B, false));
    await waitFor(() => expect(api.timeSchedule).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoOffSchedule).toHaveBeenCalledWith(B, ['s1']));
  });

  it('says so when there is nothing upcoming, and does nothing when the ask is declined', async () => {
    api.timeSchedule.mockResolvedValue(data([]));
    confirmAsk.mockResolvedValue(false);
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByLabelText('Options for Amy Adams'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Options for Amy Adams' })).getByText('Take Off the Schedule'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    expect(confirmAsk.mock.calls[0][0]).toBe('Take Amy Adams off the schedule? They have no upcoming shifts. You can put them back any time.');
    expect(api.setOnSchedule).not.toHaveBeenCalled();
  });
});

describe('The off-the-schedule footer', () => {
  it('is one quiet line with Show; Show lists them with Put Back', async () => {
    api.timeSchedule.mockResolvedValue(data([], { offSchedule: [{ email: 'cat@x.com', name: 'Cat Cole' }, { email: 'dan@x.com', name: 'Dan Dye' }] }));
    api.setOnSchedule.mockResolvedValue({ email: 'cat@x.com', on: true });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByText('2 people are off the schedule -')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Off the Schedule' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const list = screen.getByRole('list', { name: 'Off the Schedule' });
    expect(within(list).getAllByRole('listitem').map((r) => r.textContent)).toEqual(['Cat ColePut Back', 'Dan DyePut Back']);
    fireEvent.click(within(list).getAllByRole('button', { name: 'Put Back' })[0]);
    await waitFor(() => expect(api.setOnSchedule).toHaveBeenCalledWith('cat@x.com', true));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Cat Cole is back on the schedule.'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('list', { name: 'Off the Schedule' })).toBeNull();
  });

  it('is not there when nobody is off', async () => {
    api.timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('[data-off-schedule]')).toBeNull();
  });
});
