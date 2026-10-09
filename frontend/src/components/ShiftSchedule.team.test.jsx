import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// The Schedule, 10/02: one team at a time (the switcher), the decorated date
// block, Today only when today is out of view, click-to-place usual hours,
// per-person fill, Undo, the empty-team row, keyboard shortcuts, coverage,
// conflict dots, the Share summary and reduced motion.

const role = { current: {} };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role.current }));
const api = {
  timeSchedule: vi.fn(), timeSchedCreate: vi.fn(), timeSchedDelete: vi.fn(), timeSchedDiscard: vi.fn(), timeSchedBulk: vi.fn(),
  timeSchedCopy: vi.fn(), timeSchedUnshared: vi.fn(), timeSchedMove: vi.fn(), timeSchedCheck: vi.fn(), timeOffTypes: vi.fn(),
  timeShiftGroupMembers: vi.fn(), timeShiftGroupMeta: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || vi.fn().mockResolvedValue({}) }) }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn() } }));
vi.mock('../tasks/exporting', () => ({ exportExcel: vi.fn() }));

const ShiftSchedule = (await import('./ShiftSchedule')).default;
const { formatRangeShort } = await import('../lib/datetime');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
const plusDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
const us = (s) => { const [y, m, d] = s.split('-'); return `${m}/${d}/${y}`; };
const A = 'amy@x.com', B = 'bob@x.com', C = 'cat@x.com', D = 'dan@x.com';
const shift = (over) => ({ id: 's1', email: A, date: monday, shiftId: 'p1', start: '09:00', end: '17:00', label: '', note: '', published: true,
  hasChanges: false, pendingDelete: false, openSlots: 0, code: 'GST', color: '#3b82f6', groupId: '', ...over });
function data(scheduled = [], over = {}) {
  return {
    employees: [{ email: A, name: 'Amy Adams' }, { email: B, name: 'Bob Brown' }, { email: C, name: 'Cat Cole' }, { email: D, name: 'Dan Dye' }],
    shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00', color: '#3b82f6', days: '1,2,3,4,5' }],
    groups: [{ id: 'g1', name: 'Front', members: [A, B], canEdit: true, sortOrder: 0 }, { id: 'g2', name: 'Back', members: [C], canEdit: true, sortOrder: 1 }],
    scheduled, timeoff: [], holidays: {}, canManage: true, timeZone: 'America/Los_Angeles', ...over,
  };
}
const teamButton = () => screen.getByRole('button', { name: 'Choose a team' });
const pickTeam = (name) => { fireEvent.click(teamButton()); fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${name}`) })); };
const cellOf = (email, day = monday) => document.querySelector(`[data-cell="${email}|${day}"]`);
const asMotion = (reduce) => vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
  matches: reduce && /reduce/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  role.current = {};
  Object.values(api).forEach((f) => f.mockReset());
  api.timeSchedCreate.mockResolvedValue({ id: 'new1' });
  api.timeSchedDelete.mockResolvedValue({ ok: true });
  api.timeSchedDiscard.mockResolvedValue({});
  api.timeSchedCopy.mockResolvedValue({ created: 3 });
  api.timeSchedUnshared.mockResolvedValue({ count: 4 });
  api.timeSchedCheck.mockResolvedValue({ warnings: [] });
  api.timeOffTypes.mockResolvedValue({ builtIn: ['vacation'], custom: [], requestsOn: true });
});

describe('Team switcher', () => {
  it('opens on the first team the signed-in person is in, with no group header row', async () => {
    role.current = { myEmail: C };
    api.timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule />);
    await screen.findByText('Cat Cole');
    expect(teamButton().textContent).toContain('Back');
    expect(teamButton().textContent).toContain('1 person');
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(document.querySelector('[data-team]')).toBeNull();               // the switcher names the team
  });

  it('else opens on the team with the most shifts this week, and its numbers are that team\'s', async () => {
    api.timeSchedule.mockResolvedValue(data([shift({ id: 'c1', email: C }), shift({ id: 'c2', email: C, date: plusDays(monday, 1) }), shift({ id: 'a1' })]));
    render(<ShiftSchedule />);
    await screen.findByText('Cat Cole');
    expect(teamButton().textContent).toMatch(/Back.*1 person · 16 Hrs/);
    expect(screen.getByText('Week · 16 Hrs')).toBeTruthy();
    fireEvent.click(teamButton());
    const front = screen.getByRole('option', { name: /^Front/ });
    expect(front.textContent).toContain('2 people');
    expect(front.textContent).toContain('8 Hrs');
  });

  it('remembers the choice per person', async () => {
    role.current = { myEmail: A };
    api.timeSchedule.mockResolvedValue(data([shift()]));
    const { unmount } = render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    pickTeam('Back');
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(localStorage.getItem(`nexus.shifts.team.${A}`)).toBe('g2');
    unmount();
    render(<ShiftSchedule />);
    await screen.findByText('Cat Cole');
    expect(teamButton().textContent).toContain('Back');
  });

  it('All Teams stacks every team; People Without a Team shows the rest', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    pickTeam('All Teams');
    expect([...document.querySelectorAll('[data-team]')].map((r) => r.getAttribute('data-team'))).toEqual(['g1', 'g2']);
    expect(screen.getByText('Everyone Else')).toBeTruthy();
    pickTeam('People Without a Team');
    expect(screen.getByText('Dan Dye')).toBeTruthy();
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.queryByText('Cat Cole')).toBeNull();
    expect(teamButton().textContent).toContain('People Without a Team');
  });

  it('moves with the arrow keys and Enter, closes on Escape, and lists the drafts and open shifts waiting', async () => {
    api.timeSchedule.mockResolvedValue(data([shift({ published: false }), shift({ id: 'o1', email: '', openSlots: 2, groupId: 'g2', published: true })]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    fireEvent.click(teamButton());
    const list = screen.getByRole('listbox', { name: 'Teams' });
    expect(within(list).getByRole('option', { name: /^Front/ }).textContent).toContain('1 draft');
    expect(within(list).getByRole('option', { name: /^Back/ }).textContent).toContain('2 open');
    expect(within(list).getByRole('option', { name: /^Front/ }).textContent).toContain('1');   // its 1-9 shortcut
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(teamButton().textContent).toContain('Back');
    fireEvent.click(teamButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('switches teams with 1-9 while the schedule has focus', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    // The 1-9 listener attaches in an effect after the data lands; on a busy
    // CI runner the first key could beat it (failed once on PR #464), so
    // press until the switch is seen rather than assuming it is instant.
    await waitFor(() => {
      fireEvent.keyDown(document.body, { key: '2' });
      expect(teamButton().textContent).toContain('Back');
    });
    fireEvent.keyDown(teamButton(), { key: '1' });
    await waitFor(() => expect(teamButton().textContent).toContain('Front'));
  });
});

describe('Date block and week keys', () => {
  it('reads the range decorated, keeps MM/DD/YYYY as the tooltip, hides Today on this week, and jumps from its calendar', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    const block = document.querySelector('.date-block');
    expect(block.querySelector('[data-range-title]').textContent).toBe(formatRangeShort(monday, plusDays(monday, 6)));
    expect(block.querySelector('[data-range-caption]').textContent).toMatch(/^\d{4} · Week \d+ · This Week$/);
    expect(block.getAttribute('title')).toBe(`${us(monday)} - ${us(plusDays(monday, 6))}`);
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
    fireEvent.click(block);
    const target = plusDays(monday, 7);
    const picker = screen.getByRole('dialog', { name: 'Pick a date' });
    if (!within(picker).queryByRole('button', { name: `Go to ${us(target)}` })) fireEvent.click(within(picker).getByRole('button', { name: 'Next month' }));
    fireEvent.click(within(picker).getByRole('button', { name: `Go to ${us(target)}` }));
    await waitFor(() => expect(api.timeSchedule).toHaveBeenLastCalledWith(target, plusDays(target, 6)));
    expect(document.querySelector('[data-range-caption]').textContent).toContain('Next Week');
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(api.timeSchedule).toHaveBeenLastCalledWith(monday, plusDays(monday, 6)));
  });

  it('moves a week with Left / Right and comes back with T - never while typing', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    await waitFor(() => expect(api.timeSchedule).toHaveBeenLastCalledWith(plusDays(monday, 7), plusDays(monday, 13)));
    fireEvent.keyDown(document.body, { key: 't' });
    await waitFor(() => expect(api.timeSchedule).toHaveBeenLastCalledWith(monday, plusDays(monday, 6)));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const calls = api.timeSchedule.mock.calls.length;
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(api.timeSchedule.mock.calls.length).toBe(calls);
    input.remove();
  });
});

describe('Building a week in clicks', () => {
  const usualData = (scheduled = []) => data(scheduled, { usual: { [A]: 'p1', [B]: 'p1' } });

  it('places the usual shift on a click of an empty day, and Shift+click opens the editor', async () => {
    api.timeSchedule.mockResolvedValue(usualData([shift()]));
    render(<ShiftSchedule toastOk={vi.fn()} />);
    await screen.findByText('Amy Adams');
    const tue = cellOf(A, plusDays(monday, 1));
    expect(tue.getAttribute('title')).toMatch(/^Click to place 9:00a - 5:00p GST/);
    fireEvent.click(tue);
    await waitFor(() => expect(api.timeSchedCreate).toHaveBeenCalledWith(expect.objectContaining({ employee_email: A, work_date: plusDays(monday, 1), shift_id: 'p1' })));
    // Undo removes exactly what was placed.
    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain('GST placed as a draft.');
    fireEvent.click(within(bar).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.timeSchedDelete).toHaveBeenCalledWith('new1'));
    // Saturday is not a usual day: no ghost, the editor opens.
    expect(cellOf(A, plusDays(monday, 5)).querySelector('[data-ghost]')).toBeNull();
    fireEvent.click(cellOf(B, plusDays(monday, 2)), { shiftKey: true });
    expect(screen.getByRole('dialog', { name: /Add Shift/ })).toBeTruthy();
  });

  it('fills one person\'s usual hours from their menu, and Undo deletes the drafts it made', async () => {
    api.timeSchedule.mockResolvedValueOnce(usualData([shift()]))
      .mockResolvedValue(usualData([shift(), shift({ id: 'f1', date: plusDays(monday, 1), published: false }), shift({ id: 'f2', date: plusDays(monday, 2), published: false })]));
    api.timeSchedBulk.mockResolvedValue({ created: 2 });
    render(<ShiftSchedule toastOk={vi.fn()} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByLabelText('Options for Amy Adams'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Options for Amy Adams' })).getByText('Fill Usual Hours'));
    await waitFor(() => expect(api.timeSchedBulk).toHaveBeenCalledWith({ shift_id: 'p1', emails: [A], start_date: monday, end_date: plusDays(monday, 6),
      weekdays: [0, 1, 2, 3, 4], skip_timeoff: true, overwrite: false }));
    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain('Placed 2 shifts from usual hours for Amy Adams.');
    fireEvent.click(within(bar).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.timeSchedDelete).toHaveBeenCalledTimes(2));
    expect(api.timeSchedDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['f1', 'f2']);
    // The hover action does the same.
    expect(screen.getByLabelText('Fill usual hours for Amy Adams')).toBeTruthy();
  });

  it('puts a deleted draft back on Undo', async () => {
    api.timeSchedule.mockResolvedValue(data([shift({ published: false, note: 'Keys', breakMin: 30 })]));
    render(<ShiftSchedule toastOk={vi.fn()} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(document.querySelector('[data-shift="s1"]'));
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(api.timeSchedDelete).toHaveBeenCalledWith('s1'));
    fireEvent.click(within(await screen.findByRole('status')).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.timeSchedCreate).toHaveBeenCalledWith(expect.objectContaining({ employee_email: A, work_date: monday, shift_id: 'p1', note: 'Keys', break_min: 30 })));
  });

  it('greets a team with nothing this week with Fill Usual Hours and Copy Last Week', async () => {
    api.timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={vi.fn()} />);
    const row = (await screen.findByText(/^No shifts yet for Front this week/)).closest('[data-empty-team]');
    fireEvent.click(within(row).getByRole('button', { name: /Copy Last Week/ }));
    await waitFor(() => expect(api.timeSchedCopy).toHaveBeenCalledWith(expect.objectContaining({ source_start: plusDays(monday, -7), source_end: plusDays(monday, -1), target_start: monday, group_id: 'g1' })));
    expect(within(row).getByRole('button', { name: /Fill Usual Hours/ })).toBeTruthy();
  });
});

describe('Coverage and conflicts', () => {
  it('shows expected vs on per day for the team, says who is missing, and points at their empty day', async () => {
    api.timeSchedule.mockResolvedValue(data([shift()], { usual: { [A]: 'p1', [B]: 'p1' } }));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    const chips = [...document.querySelectorAll('[data-coverage]')];
    expect(chips).toHaveLength(7);
    expect(chips[0].textContent).toBe('1 of 2on');
    expect(chips[0].getAttribute('data-coverage')).toBe('short1');
    expect(chips[0].getAttribute('title')).toBe('Missing: Bob Brown');
    expect(chips[1].getAttribute('data-coverage')).toBe('short2');
    expect(chips[5].getAttribute('data-coverage')).toBe('none');            // Saturday: nobody expected
    fireEvent.click(chips[0]);
    expect(cellOf(B).className).toContain('m-pulse-cell');
    // Off under ⋯, remembered.
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'More' })).getByRole('menuitemcheckbox', { name: /Show Coverage/ }));
    expect(document.querySelector('[data-coverage]')).toBeNull();
  });

  it('dots a duplicate and an overlap, counts them in the corner, and the count goes to the first one', async () => {
    api.timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', published: false }), shift({ id: 'b1', email: B, start: '20:00', end: '04:00' }),
      shift({ id: 'b2', email: B, date: plusDays(monday, 1), start: '02:00', end: '06:00' })]));
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('[data-shift="s1"] [data-conflict-dot]').getAttribute('aria-label')).toBe('Warning: Duplicate of another shift');
    expect(document.querySelector('[data-shift="b1"] [data-conflict-dot]').getAttribute('aria-label')).toBe('Warning: Overlaps 2:00a - 6:00a');
    const link = screen.getByRole('button', { name: /^4 conflicts$/ });
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(link);
    expect(document.querySelector('[data-shift="s1"]').classList.contains('m-pulse')).toBe(true);
  });
});

describe('Share summary and motion', () => {
  it('leads with where 50+ changes are and picks this week and next', async () => {
    api.timeSchedule.mockResolvedValue({ ...data([shift({ published: false })]), unsharedCount: 242 });
    api.timeSchedUnshared.mockResolvedValueOnce({ count: 4 }).mockResolvedValueOnce({ count: 8 }).mockResolvedValue({ count: 12 });
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    const share = screen.getByRole('button', { name: /^Share, 242 unshared/ });
    expect(share.getAttribute('title')).toBe('242 changes your team has not seen yet');
    fireEvent.click(share);
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    await waitFor(() => expect(dlg.textContent).toContain('This week: 4 · Next week: 8 · Other weeks: 230'));
    expect(within(dlg).getByLabelText('Share from').value).toBe(monday);
    expect(within(dlg).getByLabelText('Share to').value).toBe(plusDays(monday, 13));
  });

  it('animates the grid in, and not at all with reduced motion', async () => {
    let mm = asMotion(false);
    api.timeSchedule.mockResolvedValue(data([shift()]));
    const { unmount } = render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('.week-grid').className).toContain('m-stagger');
    expect(document.querySelector('.week-grid').parentElement.className).toMatch(/m-(fade|slide)/);
    unmount(); mm.mockRestore();
    mm = asMotion(true);
    render(<ShiftSchedule />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('.week-grid').className).not.toContain('m-stagger');
    expect(document.querySelector('.week-grid').parentElement.className).not.toMatch(/m-(fade|slide|pop)/);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await act(async () => {});
    expect(document.querySelector('[data-range-title]').parentElement.className || '').not.toMatch(/m-slide/);
    mm.mockRestore();
  });
});
