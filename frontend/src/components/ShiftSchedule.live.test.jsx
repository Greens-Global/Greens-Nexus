import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Shift Planner, 11/04/2026 (Neil): a change shows the moment it is made and
// syncs in the background; a refusal takes it back. And a shift's edge can be
// pulled across the next days to copy it there.

const role = { current: {} };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role.current }));
const api = {
  timeSchedule: vi.fn(), timeSchedCreate: vi.fn(), timeSchedDelete: vi.fn(), timeSchedDiscard: vi.fn(), timeSchedMove: vi.fn(),
  timeSchedCheck: vi.fn(), timeOffTypes: vi.fn(), timeSchedConfirmations: vi.fn(), timeSchedUnshared: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || vi.fn().mockResolvedValue({}) }) }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn() } }));
vi.mock('../tasks/exporting', () => ({ exportExcel: vi.fn() }));

const ShiftSchedule = (await import('./ShiftSchedule')).default;

// jsdom has no PointerEvent; the grips pull with pointer events.
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerType = init.pointerType || 'mouse'; this.pointerId = init.pointerId ?? 1; }
  };
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
const plusDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
const A = 'amy@x.com', B = 'bob@x.com';
const shift = (over) => ({ id: 's1', email: A, date: monday, shiftId: 'p1', start: '09:00', end: '17:00', label: '', note: '', published: false,
  hasChanges: false, pendingDelete: false, openSlots: 0, code: 'GST', color: '#3b82f6', groupId: 'g1', breakMin: 0, ...over });
const data = (scheduled = []) => ({
  employees: [{ email: A, name: 'Amy Adams', canEdit: true }, { email: B, name: 'Bob Brown', canEdit: true }],
  shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00', color: '#3b82f6', days: '1,2,3,4,5' }],
  groups: [{ id: 'g1', name: 'Front', members: [A, B], canEdit: true, sortOrder: 0 }],
  scheduled, timeoff: [], holidays: {}, canManage: true, timeZone: 'America/Los_Angeles',
});
const blockOf = (id) => document.querySelector(`[data-shift="${id}"]`);
const pending = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const toastOk = vi.fn(), toastErr = vi.fn();

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  role.current = { myEmail: A };
  Object.values(api).forEach((f) => f.mockReset());
  toastOk.mockReset(); toastErr.mockReset();
  api.timeSchedCheck.mockResolvedValue({ warnings: [] });
  api.timeOffTypes.mockResolvedValue({ builtIn: ['vacation'], custom: [], requestsOn: true });
  api.timeSchedConfirmations.mockResolvedValue({ people: [], unconfirmed: 0 });
  api.timeSchedUnshared.mockResolvedValue({ count: 0 });
});

describe('Instant changes', () => {
  it('takes a draft off the grid at once, before the server answers, then syncs quietly', async () => {
    api.timeSchedule.mockResolvedValue(data([shift({ id: 'd1' })]));
    const del = pending();
    api.timeSchedDelete.mockReturnValue(del.p);
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    const loads = api.timeSchedule.mock.calls.length;
    blockOf('d1').focus();
    fireEvent.keyDown(blockOf('d1'), { key: 'Delete' });
    expect(blockOf('d1')).toBeNull();                                 // gone now, still saving
    expect(api.timeSchedDelete).toHaveBeenCalledWith('d1');
    api.timeSchedule.mockResolvedValue(data([]));
    await act(async () => { del.res({ ok: true, pending: false }); });
    await waitFor(() => expect(api.timeSchedule.mock.calls.length).toBeGreaterThan(loads), { timeout: 2000 });
    expect(blockOf('d1')).toBeNull();
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('puts the shift back and says why when the server refuses', async () => {
    api.timeSchedule.mockResolvedValue(data([shift({ id: 'd1' })]));
    const del = pending();
    api.timeSchedDelete.mockReturnValue(del.p);
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    fireEvent.keyDown(blockOf('d1'), { key: 'Delete' });
    expect(blockOf('d1')).toBeNull();
    await act(async () => { del.rej(new Error('Outside your team')); });
    expect(blockOf('d1')).toBeTruthy();
    expect(toastErr).toHaveBeenCalledWith('Outside your team');
  });
});

describe('Stretch to copy', () => {
  // jsdom lays nothing out: give each of Amy's day cells a 100px column.
  const layOut = () => {
    document.querySelectorAll(`[data-cell^="${A}|"]`).forEach((el) => {
      const c = Number(el.getAttribute('data-c'));
      el.getBoundingClientRect = () => ({ left: c * 100, right: c * 100 + 100, top: 0, bottom: 40, width: 100, height: 40, x: c * 100, y: 0 });
    });
  };

  it('copies the shift into every empty day it is pulled over, skipping a day that has one, instantly', async () => {
    const wed = plusDays(monday, 2), thu = plusDays(monday, 3);
    api.timeSchedule.mockResolvedValue(data([shift({ id: 'm1' }), shift({ id: 'w1', date: wed, start: '12:00', end: '16:00' })]));
    const saves = [];
    api.timeSchedCreate.mockImplementation((p) => { const d = pending(); saves.push({ p, d }); return d.p; });
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    layOut();
    const grip = blockOf('m1').querySelector('[data-stretch="right"]');
    expect(grip).toBeTruthy();
    fireEvent.pointerDown(grip, { button: 0, clientX: 95, clientY: 20, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 350, clientY: 60 });   // Thursday's column, a row lower
    expect(document.querySelector(`[data-cell="${A}|${thu}"]`).style.outline).toContain('dashed');
    fireEvent.pointerUp(window, { clientX: 350, clientY: 60 });
    expect(saves.map((x) => x.p.work_date)).toEqual([plusDays(monday, 1), thu]);   // Wednesday already had one
    expect(saves.every((x) => x.p.employee_email === A && x.p.shift_id === 'p1' && x.p.start_hhmm === '09:00')).toBe(true);
    // On screen before either save came back.
    expect(document.querySelectorAll(`[data-cell="${A}|${thu}"] [data-shift]`).length).toBe(1);
    await act(async () => { saves.forEach((x, i) => x.d.res({ ...shift({ id: `n${i}`, date: x.p.work_date }) })); });
    // One Undo for the lot, saying what was skipped.
    expect(await screen.findByText(/copied to 2 more days as drafts\. Skipped 1 day that already had one/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
  });

  it('pulls the left edge back into earlier days only', async () => {
    const fri = plusDays(monday, 4);
    api.timeSchedule.mockResolvedValue(data([shift({ id: 'f1', date: fri })]));
    api.timeSchedCreate.mockImplementation((p) => Promise.resolve(shift({ id: `x-${p.work_date}`, date: p.work_date })));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    layOut();
    const grip = blockOf('f1').querySelector('[data-stretch="left"]');
    fireEvent.pointerDown(grip, { button: 0, clientX: 405, clientY: 20, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 650, clientY: 20 });   // to the right: nothing for a left pull
    fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });   // Wednesday
    fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
    await waitFor(() => expect(api.timeSchedCreate).toHaveBeenCalledTimes(2));
    expect(api.timeSchedCreate.mock.calls.map((c) => c[0].work_date)).toEqual([plusDays(monday, 2), plusDays(monday, 3)]);
  });

  it('offers no grip to someone who only reads the schedule', async () => {
    api.timeSchedule.mockResolvedValue({ ...data([shift({ id: 'r1', published: true })]), canManage: false });
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('[data-stretch]')).toBeNull();
  });
});

describe('Weeks show at once', () => {
  it('reads the weeks either side ahead, so Next and Previous show the grid with no wait', async () => {
    api.timeSchedule.mockImplementation((s) => Promise.resolve(data([shift({ id: `w-${s}`, date: s })])));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    const next = plusDays(monday, 7), prev = plusDays(monday, -7);
    await waitFor(() => {
      const asked = api.timeSchedule.mock.calls.map((c) => c[0]);
      expect(asked).toContain(next);
      expect(asked).toContain(prev);
    }, { timeout: 2000 });
    await act(async () => { await Promise.resolve(); });
    const slow = pending();
    api.timeSchedule.mockReturnValue(slow.p);                          // the refresh behind is still out
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(blockOf(`w-${next}`)).toBeTruthy();                         // the read-ahead copy, at once
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(blockOf(`w-${monday}`)).toBeTruthy();                       // a week seen before, at once
    await act(async () => { slow.res(data([shift({ id: 'fresh', date: monday })])); });
    await waitFor(() => expect(blockOf('fresh')).toBeTruthy());        // then the fresh copy
  });
});
