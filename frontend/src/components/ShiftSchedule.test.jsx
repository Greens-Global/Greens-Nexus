import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The schedule grid (rebuilt Oct 2026, Teams parity; decluttered 10/02):
// one toolbar row, blocks of one calm line that open the editor on a click,
// time off beside shifts as an outlined block, open shifts per group,
// keyboard and touch reach, Share with a date range, an error with Retry,
// and a day list (never a 7-column grid) on a phone.

const timeSchedule = vi.fn();
const timeShiftAssign = vi.fn(async () => ({ ok: true, assigned: 1 }));
const timeSchedDelete = vi.fn();
const timeSchedDiscard = vi.fn();
const timeSchedPublish = vi.fn();
const timeSchedUnshared = vi.fn();
const timeSchedPublishReview = vi.fn();
const timeSchedHistory = vi.fn();
const timeSchedCellHistory = vi.fn();
const timeSchedShares = vi.fn();
const timeSchedCheck = vi.fn();
const timeSchedCopy = vi.fn();
const timeSchedClear = vi.fn();
const timeSchedMove = vi.fn();
const timeSchedDayNote = vi.fn();
const timeSchedUpdate = vi.fn();
const exportExcel = vi.fn();
const timeSchedDiscardAll = vi.fn();
const confirmAsk = vi.fn();
const timeSchedImport = vi.fn();
const timeSchedCreate = vi.fn();
const timeOffTypes = vi.fn();
const timeOffOnBehalf = vi.fn();
const timeOffDecide = vi.fn();
const timeShiftGroupMembers = vi.fn();
const timeShiftGroupMeta = vi.fn();
const sheetRows = { current: [] };
vi.mock('xlsx', () => ({ read: () => ({ SheetNames: ['S'], Sheets: { S: {} } }), utils: { sheet_to_json: () => sheetRows.current } }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a), prompt: vi.fn() } }));
vi.mock('../tasks/exporting', () => ({ exportExcel: (...a) => exportExcel(...a) }));
const weatherCallScreen = vi.fn();
const timeSchedActuals = vi.fn();
const timeSchedConfirmations = vi.fn();
const timeSchedNudge = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeSchedule: (...a) => timeSchedule(...a),
    timeSchedActuals: (...a) => timeSchedActuals(...a),
    timeSchedConfirmations: (...a) => timeSchedConfirmations(...a),
    timeSchedNudge: (...a) => timeSchedNudge(...a),
    weatherCallScreen: (...a) => weatherCallScreen(...a),
    timeShiftAssign: (...a) => timeShiftAssign(...a),
    timeSchedDelete: (...a) => timeSchedDelete(...a),
    timeSchedDiscard: (...a) => timeSchedDiscard(...a),
    timeSchedPublish: (...a) => timeSchedPublish(...a),
    timeSchedUnshared: (...a) => timeSchedUnshared(...a),
    timeSchedPublishReview: (...a) => timeSchedPublishReview(...a),
    timeSchedHistory: (...a) => timeSchedHistory(...a),
    timeSchedCellHistory: (...a) => timeSchedCellHistory(...a),
    timeSchedShares: (...a) => timeSchedShares(...a),
    timeSchedCreate: (...a) => timeSchedCreate(...a),
    timeSchedUpdate: (...a) => timeSchedUpdate(...a),
    timeSchedMove: (...a) => timeSchedMove(...a),
    timeSchedDayNote: (...a) => timeSchedDayNote(...a),
    timeSchedCheck: (...a) => timeSchedCheck(...a),
    timeSchedCopy: (...a) => timeSchedCopy(...a),
    timeSchedClear: (...a) => timeSchedClear(...a),
    timeSchedDiscardAll: (...a) => timeSchedDiscardAll(...a),
    timeSchedImport: (...a) => timeSchedImport(...a),
    timeOffTypes: (...a) => timeOffTypes(...a),
    timeOffOnBehalf: (...a) => timeOffOnBehalf(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    timeSchedAssign: vi.fn(), timeSchedBulk: vi.fn(),
    timeShiftGroupMembers: (...a) => timeShiftGroupMembers(...a),
    timeShiftGroupMeta: (...a) => timeShiftGroupMeta(...a),
    timeShiftGroupOrder: vi.fn().mockResolvedValue({}), timeShiftGroupReorder: vi.fn().mockResolvedValue({}), timeShiftGroupDelete: vi.fn().mockResolvedValue({}),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'cat@greensglobal.com', name: 'Cat Cole' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const ShiftSchedule = (await import('./ShiftSchedule')).default;

// jsdom has no PointerEvent; the grid drags and long-presses with pointer events.
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerType = init.pointerType || 'mouse'; this.pointerId = init.pointerId ?? 1; }
  };
}

const monday = (() => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const today = (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; })();
const formatUs = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
function plusDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const shift = (over) => ({
  id: 's1', email: 'amy@greensglobal.com', date: monday, shiftId: 'p1', start: '09:00', end: '17:00',
  label: '', note: '', published: true, hasChanges: false, pendingDelete: false, openSlots: 0, code: 'GST', color: '#3b82f6', groupId: '', ...over,
});
function data(scheduled) {
  return {
    employees: [{ email: 'amy@greensglobal.com', name: 'Amy Adams' }, { email: 'bob@greensglobal.com', name: 'Bob Brown' }],
    shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00', color: '#3b82f6', days: '1,2,3,4,5' },
      { id: 'p2', code: 'NGT', name: 'Night', start: '21:00', end: '05:00', color: '#8b5cf6' }],
    groups: [], scheduled, timeoff: [], holidays: {}, canManage: true, timeZone: 'America/Los_Angeles',
  };
}
const cellOf = (email, day = monday) => document.querySelector(`[data-cell="${email}|${day}"]`);
const blockOf = (id) => document.querySelector(`[data-shift="${id}"]`);
const pointerDrag = (from, to, keys = {}) => {
  document.elementFromPoint = () => to;
  fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10, pointerType: 'mouse' });
  fireEvent.pointerMove(window, { clientX: 80, clientY: 40, ...keys });
  fireEvent.pointerUp(window, { clientX: 80, clientY: 40, ...keys });
  fireEvent.click(to);
};
const more = (label) => { fireEvent.click(screen.getByRole('button', { name: 'More' })); fireEvent.click(within(screen.getByRole('menu', { name: 'More' })).getByText(label)); };
const add = (label) => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); fireEvent.click(within(screen.getByRole('menu', { name: 'Add' })).getByText(label)); };
// Customize (Oct 28 2026) is its own toolbar button; Export is a dropdown; Import a button.
const viewOptions = () => { more('Customize'); return screen.getByRole('dialog', { name: 'Customize' }); };
// Print is a toolbar button; Export to Excel sits under More (Oct 29 2026).
const exportMenu = (label) => (label === 'Print' ? fireEvent.click(screen.getByRole('button', { name: 'Print' })) : more(label));
const toastOk = vi.fn();
const toastErr = vi.fn();
// The stacked view of every team (10/02: the schedule shows one team at a
// time; the tests below that look at several groups at once pick All Teams).
const allTeams = () => { try { localStorage.setItem('nexus.shifts.team.anon', '__all'); } catch { /* none */ } };
// A 390px phone: the app's breakpoint hook reads matchMedia('(max-width: 640px)').
const asPhone = () => vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
  matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  // All Teams starts with every team folded (Oct 29 2026); most tests look
  // inside the teams, so they start open. The folding test clears this.
  try { localStorage.setItem('nexus.shifts.fold.anon', JSON.stringify({ g1: false, g2: false, g3: false })); } catch { /* none */ }
  toastOk.mockReset(); toastErr.mockReset();
  timeSchedule.mockReset();
  timeShiftGroupMembers.mockReset().mockResolvedValue({});
  timeShiftGroupMeta.mockReset().mockResolvedValue({});
  timeSchedDelete.mockReset().mockResolvedValue({ ok: true, pending: true });
  timeSchedDiscard.mockReset().mockResolvedValue({});
  timeSchedPublish.mockReset().mockResolvedValue({ published: 1, added: 1, notified: 1 });
  timeSchedUnshared.mockReset().mockResolvedValue({ count: 1 });
  timeSchedPublishReview.mockReset().mockResolvedValue({ changes: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', kind: 'added', date: monday, start: '09:00', end: '17:00', label: '', was: null }], people: 1, warnings: [], reasonRequired: false });
  timeSchedHistory.mockReset().mockResolvedValue({ entries: [] });
  timeSchedCellHistory.mockReset().mockResolvedValue({ entries: [] });
  timeSchedShares.mockReset().mockResolvedValue({ shares: [] });
  timeSchedCheck.mockReset().mockResolvedValue({ warnings: [] });
  timeSchedCopy.mockReset().mockResolvedValue({ created: 4, replaced: 0, skipped: 1, timeoffSkipped: 0, targetStart: plusDays(monday, 7), targetEnd: plusDays(monday, 13) });
  timeSchedClear.mockReset().mockResolvedValue({ removed: 2, pending: 1 });
  timeSchedMove.mockReset().mockResolvedValue({ moved: true, sourcePending: false });
  timeSchedDayNote.mockReset().mockResolvedValue({});
  timeSchedUpdate.mockReset().mockResolvedValue({});
  exportExcel.mockReset().mockResolvedValue();
  timeSchedDiscardAll.mockReset().mockResolvedValue({ discarded: 2 });
  confirmAsk.mockReset().mockResolvedValue(true);
  timeSchedImport.mockReset().mockResolvedValue({ created: 2, errorCount: 0, errors: [] });
  timeSchedCreate.mockReset().mockResolvedValue({});
  timeOffTypes.mockReset().mockResolvedValue({ builtIn: ['vacation', 'sick', 'personal', 'unpaid', 'other'], custom: ['Jury Duty'], requestsOn: true });
  timeOffOnBehalf.mockReset().mockResolvedValue({ id: 't9' });
  timeOffDecide.mockReset().mockResolvedValue({});
  timeSchedActuals.mockReset().mockResolvedValue({ cells: {}, people: {}, totals: {} });
  timeSchedConfirmations.mockReset().mockResolvedValue({ people: [], unconfirmed: 0 });
  timeSchedNudge.mockReset().mockImplementation(async (b) => ({ nudged: b.emails.length }));
});

describe('Toolbar: one row, seven controls', () => {
  it('shows the date bar first, then Fill Automatically, Add, Print, More, Discard and Save & Share (Oct 29 2026)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    const bar = screen.getByRole('toolbar', { name: 'Schedule' });
    const names = within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    // No groups: no team switcher. Today is hidden while this week is on screen.
    expect(names[0]).toBe('Previous week');
    expect(names[1]).toMatch(/· This Week\. Pick a date$/);
    expect(names.slice(2)).toEqual(['Next week', 'Day', 'Week', 'Month', 'Fill Automatically', 'Add', 'Print', 'More', 'Discard', 'Save & Share, 1 unsaved']);
    expect(screen.queryByText('Fill Schedule')).toBeNull();
    expect(screen.queryByText('Publish 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const items = within(screen.getByRole('menu', { name: 'More' })).getAllByRole('menuitem').map((b) => b.textContent.trim());
    expect(items).toEqual(['Customize', 'Export to Excel', 'Import', 'Copy Week', 'Clear Week', 'Requests', 'Keyboard Shortcuts']);
    fireEvent.keyDown(document, { key: 'Escape' });
    const d = viewOptions();
    expect(within(d).getByRole('checkbox', { name: 'Show coverage' }).checked).toBe(true);
    expect(within(d).getByRole('checkbox', { name: 'Show people without shifts' }).checked).toBe(true);
  });

  it('shows an error with Retry when the schedule cannot load, with nothing offered on it', async () => {
    timeSchedule.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText(/The schedule could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.getByRole('button', { name: /^Save & Share/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Amy Adams')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save & Share/ }).disabled).toBe(false);
  });
});

describe('Grid: blocks, time off beside shifts, open shifts per group', () => {
  const people = [{ email: 'amy@greensglobal.com', name: 'Amy Adams', photoUrl: 'https://x.supabase.co/amy.png', location: 'Escondido' },
    { email: 'bob@greensglobal.com', name: 'Bob Brown', photoUrl: '', location: '' }];
  const grid = (scheduled, over = {}) => ({ ...data(scheduled), employees: people, ...over });

  it('shows profile photos, initials, the month in the day header and Hrs with two decimals', async () => {
    timeSchedule.mockResolvedValue(grid([shift({ breakMin: 45 })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('img[src="https://x.supabase.co/amy.png"]')).toBeTruthy();
    expect(screen.getByText('BB')).toBeTruthy();
    expect(screen.getByText('Week · 7.25 Hrs')).toBeTruthy();
    const header = screen.getAllByRole('columnheader')[0];
    expect(header.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}[A-Z][a-z]{2}/);   // "Mon 28" with the month said once, on the first day
    expect(screen.getAllByRole('columnheader')[1].textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}\d/);   // the next day has no month
    expect(header.textContent).toContain('1 · 7.25 Hrs');
    // One calm line: the short time and the type's code; the break is the hover title, not the block.
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00p');
    expect(blockOf('s1').getAttribute('title')).toContain('Break 45m');
    expect(blockOf('s1').getAttribute('aria-label')).toBe('Shift 9:00 AM - 5:00 PM GST');
    // No zone chip: the shift is in the team's own zone (it used to print "PDT" on every block).
    expect(blockOf('s1').textContent).not.toMatch(/PDT|PST/);
    expect(screen.getByText(/^Times in /)).toBeTruthy();   // said once, under the grid
  });

  it('wears a zone chip only when a shift is kept in another zone', async () => {
    timeSchedule.mockResolvedValue(grid([shift({ timeZone: 'America/Los_Angeles' }), shift({ id: 's2', email: 'bob@greensglobal.com', timeZone: 'Asia/Kolkata' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00p');
    expect(blockOf('s2').textContent).toMatch(/IST|GMT\+5:30/);
    expect(blockOf('s2').getAttribute('title')).toContain('Times in');
  });

  it('draws a draft, an unshared edit and a removal differently', async () => {
    timeSchedule.mockResolvedValue(grid([shift({ id: 'a', published: false }), shift({ id: 'b', email: 'bob@greensglobal.com', hasChanges: true, start: '10:00', end: '18:00' }),
      shift({ id: 'c', date: plusDays(monday, 1), pendingDelete: true })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    // The state is a border, a corner mark or a strike - never a word on the block.
    expect(blockOf('a').getAttribute('aria-label')).toContain('Draft');
    expect(blockOf('a').style.border).toContain('dashed');
    expect(blockOf('a').textContent).toBe('9:00a - 5:00p');
    expect(blockOf('b').getAttribute('aria-label')).toContain('Edited');
    expect(blockOf('b').querySelector('[title="Edited, not shared"]')).toBeTruthy();
    expect(blockOf('b').textContent).not.toContain('Edited');
    expect(blockOf('c').getAttribute('aria-label')).toContain('Removing');
    expect(blockOf('c').style.textDecoration).toBe('line-through');
    expect(screen.getByText('Week · 16 Hrs')).toBeTruthy();   // the removal is out
    expect(screen.getByRole('button', { name: 'Save & Share, 3 unsaved' })).toBeTruthy();
  });

  it('keeps the shift beside a partial day of time off, with its hours (QA 19 / 20)', async () => {
    timeSchedule.mockResolvedValue(grid([shift()], { timeoff: [
      { id: 't1', email: 'amy@greensglobal.com', startDate: monday, endDate: monday, startTime: '14:00', endTime: '16:00', allDay: false, type: 'personal', status: 'approved', note: 'Dentist' },
      { id: 't2', email: 'bob@greensglobal.com', startDate: monday, endDate: plusDays(monday, 1), type: 'vacation', status: 'pending', note: 'Yard sale' }] }));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const amy = cellOf('amy@greensglobal.com');
    expect(amy.querySelector('[data-shift="s1"]')).toBeTruthy();
    const t1 = amy.querySelector('[data-timeoff="t1"]');
    expect(t1.textContent).toBe('2:00p - 4:00p Personal');          // one soft rose line beside the shift; the reason is the hover title
    expect(t1.getAttribute('title')).toContain('Dentist');
    expect(screen.getByText('Week · 8 Hrs')).toBeTruthy();
    expect(screen.getByText('8 Hrs · 2 people')).toBeTruthy();
    // Two whole days off are ONE pill across both columns, the range said once.
    const t2 = document.querySelectorAll('[data-timeoff="t2"]');
    expect(t2.length).toBe(1);
    expect(t2[0].textContent).toMatch(/^Vacation · [A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}$/);
    expect(t2[0].style.gridColumn).toBe('2 / span 2');
    expect(t2[0].style.border).toContain('dashed');                   // only requested
    expect(t2[0].getAttribute('title')).toContain(`Requested\n${formatUs(monday)} - ${formatUs(plusDays(monday, 1))}\nYard sale`);
    expect(cellOf('bob@greensglobal.com').textContent).toBe('');       // the cells under it stay empty
  });

  it('puts open shifts on their group\'s row, and ungrouped ones on the top row', async () => {
    allTeams();
    timeSchedule.mockResolvedValue({ ...grid([shift(), shift({ id: 'o1', email: '', openSlots: 3, code: 'OPEN', groupId: 'g1' }), shift({ id: 'o2', email: '', openSlots: 1, code: 'OLD', groupId: '' })]),
      groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true }, { id: 'g2', name: 'Back', members: ['bob@greensglobal.com'], canEdit: true }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('[data-open-row="g1"] [data-shift="o1"]')).toBeTruthy();
    expect(document.querySelector('[data-open-row="all"] [data-shift="o2"]')).toBeTruthy();
    expect(document.querySelector('[data-open-row="g2"] [data-shift]')).toBeNull();
    expect(document.querySelector('[data-open-row="g1"]').textContent).toContain('3 open · 24 Hrs');
    expect(blockOf('o1').textContent).toContain('×3');
    expect(screen.getByText('Week · 8 Hrs')).toBeTruthy();   // people only; open spots have their own row
    expect(screen.getByText('8 Hrs · 1 person')).toBeTruthy();
    // Collapse a group: its rows go, the header stays.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Front' }));
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.getByText('Front')).toBeTruthy();
  });

  it('groups people by location from View Options', async () => {
    timeSchedule.mockResolvedValue(grid([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const dlg = viewOptions();
    fireEvent.change(within(dlg).getByLabelText('Group people by'), { target: { value: 'location' } });
    expect(screen.getByText('Escondido')).toBeTruthy();
    expect(screen.getByText('No Location Set')).toBeTruthy();
  });

  it('calls the corner count warnings once any of them is a schedule rule (Oct 15)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ conflicts: ['Only 8h 00m rest before this shift (10h minimum).'], ruleWarnings: ['Only 8h 00m rest before this shift (10h minimum).'] })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByRole('button', { name: /^1 warning$/ })).toBeTruthy();
  });

  it('marks people with limited availability, and a conflict on a shift', async () => {
    timeSchedule.mockResolvedValue({ ...grid([shift({ conflicts: ['On approved time off that day (sick).'] })]),
      availability: { 'amy@greensglobal.com': [{ weekday: 0, kind: 'unavailable', start: '', end: '', note: '' }, { weekday: 1, kind: 'available', start: '08:00', end: '12:00', note: '' }] } });
    render(<ShiftSchedule toastOk={toastOk} />);
    const tag = await screen.findByText('Limited Availability');
    expect(tag.getAttribute('title')).toBe('Not fully available on a day they usually work: Mon unavailable · Tue 8:00 AM - 12:00 PM. Set in their My Availability; it never blocks a shift.');
    // The API's sentence stays; the grid adds what it sees itself, one short line each.
    expect(screen.getByLabelText('Warning: Outside availability: Mon unavailable; On approved time off that day (sick).')).toBeTruthy();
  });
});

describe('The week grid engine (WeekGrid, 10/02)', () => {
  const groups2 = (scheduled, over = {}) => ({ ...data(scheduled),
    groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true, openShifts: true, sortOrder: 0 },
      { id: 'g2', name: 'Back', members: ['bob@greensglobal.com'], canEdit: true, sortOrder: 1 }], ...over });

  it('puts every cell of a row in the ONE grid, on the same grid row - so they are the same height', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', date: plusDays(monday, 2), label: 'Front Desk' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const grids = document.querySelectorAll('[data-week-grid]');
    expect(grids).toHaveLength(1);
    const grid = grids[0];
    expect(grid.style.display).toBe('grid');
    expect(grid.style.gridTemplateColumns).toBe('200px repeat(7, minmax(0, 1fr))');
    const row = document.querySelector('[data-member="amy@greensglobal.com"]');
    expect(row.style.display).toBe('contents');                         // a row is never a box of its own
    expect(row.parentElement).toBe(grid);
    const cells = [...row.querySelectorAll('[data-cell]')];
    expect(cells).toHaveLength(7);
    const line = row.querySelector('[data-person]').style.gridRow;
    expect(line).toMatch(/^\d+$/);
    cells.forEach((c, i) => {
      expect(c.style.gridRow).toBe(line);                                // same grid row = same height, by construction
      expect(c.style.gridColumn).toBe(String(i + 2));
      expect(c.style.height).toBe('');                                   // nothing sizes a cell on its own
      expect(c.style.minHeight).toBe('');
    });
    expect(grid.style.gridTemplateRows).toContain('minmax(52px, auto)');
  });

  it('draws whole days off as ONE pill across the days, clipped at the week edge with chevrons', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ id: 'fri', email: 'bob@greensglobal.com', date: plusDays(monday, 4) })]),
      timeoff: [{ id: 'v1', email: 'bob@greensglobal.com', startDate: plusDays(monday, -2), endDate: plusDays(monday, 3), type: 'vacation', status: 'approved' },
        { id: 'v2', email: 'amy@greensglobal.com', startDate: plusDays(monday, 5), endDate: plusDays(monday, 9), type: 'sick', status: 'approved' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const v1 = document.querySelectorAll('[data-timeoff="v1"]');
    expect(v1).toHaveLength(1);                                          // one pill, never one per day
    expect(v1[0].style.gridColumn).toBe('2 / span 4');
    expect(v1[0].textContent).toMatch(/^Vacation · [A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}$/);
    expect(within(v1[0]).getByLabelText('Continues from last week')).toBeTruthy();
    expect(within(v1[0]).queryByLabelText('Continues next week')).toBeNull();
    expect(v1[0].style.border).toContain('solid');                      // approved
    expect(v1[0].closest('[data-member]').getAttribute('data-member')).toBe('bob@greensglobal.com');
    // The shift after it keeps its own cell.
    expect(cellOf('bob@greensglobal.com', plusDays(monday, 4)).querySelector('[data-shift="fri"]')).toBeTruthy();
    const v2 = document.querySelector('[data-timeoff="v2"]');
    expect(v2.style.gridColumn).toBe('7 / span 2');
    expect(within(v2).getByLabelText('Continues next week')).toBeTruthy();
  });

  it('folds every team in All Teams, says so in one row, and remembers what the user opens (Oct 29 2026)', async () => {
    try { localStorage.removeItem('nexus.shifts.fold.anon'); } catch { /* none */ }
    allTeams();
    timeSchedule.mockResolvedValue(groups2([shift()]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByRole('button', { name: 'Expand Front' });            // even a team with shifts starts folded
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('1 person · no shifts this week')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Back' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-open-row]')).toBeNull();           // a folded team shows nothing under it
    fireEvent.click(screen.getByRole('button', { name: 'Expand Front' }));
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    expect(document.querySelector('[data-open-row="g1"]')).toBeTruthy();  // a manager gets the slim Open Shifts row where open shifts are on
    fireEvent.click(screen.getByRole('button', { name: 'Expand Back' }));
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    unmount();
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Bob Brown')).toBeTruthy();         // remembered
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Front' }));
    expect(screen.queryByText('Amy Adams')).toBeNull();
  });

  it('never shows a viewer an empty Open Shifts row', async () => {
    allTeams();
    timeSchedule.mockResolvedValue({ ...groups2([shift()]), canManage: false,
      timeoff: [{ id: 'v1', email: 'bob@greensglobal.com', startDate: monday, endDate: plusDays(monday, 1), type: 'vacation', status: 'approved' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    expect(document.querySelector('[data-open-row]')).toBeNull();
  });

  it('hides people without shifts from Customize, and remembers it', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    fireEvent.click(within(viewOptions()).getByRole('checkbox', { name: 'Show people without shifts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    unmount();
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(within(viewOptions()).getByRole('checkbox', { name: 'Show people without shifts' }).checked).toBe(false);
  });
});

describe('Menus, clipboard, keyboard and touch', () => {
  it('right-click menu on a shift: color, move to open shifts, delete', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.contextMenu(blockOf('s1'));
    const menu = screen.getByRole('menu', { name: 'Shift options' });
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.replace(/Ctrl\+.|▸|▾/g, '').trim()))
      .toEqual(['Edit Shift', 'Details', 'Add Time Off', 'Color', 'Move To Open Shifts', 'Copy', 'Delete']);
    fireEvent.click(within(menu).getByText('Color'));
    fireEvent.click(screen.getByLabelText('Color #16a34a'));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ color: '#16a34a', start_hhmm: '09:00' })));
    fireEvent.contextMenu(blockOf('s1'));
    fireEvent.click(screen.getByText('Move To Open Shifts'));
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', { employee_email: '', work_date: monday, duplicate: false }));
    fireEvent.contextMenu(blockOf('s1'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('s1'));
  });

  it('places a shift type in one click from an empty day\'s menu', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.contextMenu(cellOf('bob@greensglobal.com'));
    const menu = screen.getByRole('menu', { name: 'Day options' });
    expect(within(menu).getByText('Place Shift Type')).toBeTruthy();
    fireEvent.click(within(menu).getByText(/Night · 9:00 PM - 5:00 AM/));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith({ employee_email: 'bob@greensglobal.com', work_date: monday, shift_id: 'p2', group_id: '' }));
    expect(toastOk).toHaveBeenCalledWith('Night placed as a draft.');
  });

  it('offers History on an empty day only once the API says a shift was there (Oct 15)', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.contextMenu(cellOf('bob@greensglobal.com'));
    let menu = screen.getByRole('menu', { name: 'Day options' });
    await waitFor(() => expect(timeSchedCellHistory).toHaveBeenCalledWith('bob@greensglobal.com', monday));
    expect(within(menu).queryByText('History')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    timeSchedCellHistory.mockResolvedValue({ email: 'bob@greensglobal.com', date: monday, entries: [
      { action: 'removed', actor: 'mia@greensglobal.com', actorName: 'Mia Lee', at: '2026-10-14T22:12:00Z', before: { start: '09:00', end: '17:00', label: 'Yard' }, after: null, reason: 'offboarded' },
      { action: 'created', actor: 'mia@greensglobal.com', actorName: 'Mia Lee', at: '2026-10-10T15:00:00Z', before: null, after: { start: '09:00', end: '17:00', label: 'Yard' }, reason: '' },
    ] });
    fireEvent.contextMenu(cellOf('bob@greensglobal.com'));
    menu = screen.getByRole('menu', { name: 'Day options' });
    const item = await within(menu).findByText('History');
    fireEvent.click(item);
    const dlg = screen.getByRole('dialog', { name: 'Cell History' });
    expect(dlg.textContent).toContain('Bob · ');
    expect(dlg.textContent).toContain('Removed by Mia Lee');
    expect(dlg.textContent).toContain('9:00 AM - 5:00 PM · Yard');
    expect(dlg.textContent).toContain('"offboarded"');
    expect(dlg.textContent).toContain('Created by Mia Lee');
  });

  it('copies and pastes with Ctrl+C / Ctrl+V, the menu, and a click on an empty day', async () => {
    timeSchedule.mockResolvedValue(data([shift({ breakMin: 30, groupId: 'g1' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.mouseEnter(blockOf('s1'));
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/^Shift copied/));
    fireEvent.mouseLeave(blockOf('s1'));
    fireEvent.mouseEnter(cellOf('bob@greensglobal.com'));
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith(expect.objectContaining({
      employee_email: 'bob@greensglobal.com', work_date: monday, shift_id: 'p1', start_hhmm: '09:00', break_min: 30, group_id: 'g1' })));
    fireEvent.contextMenu(cellOf('bob@greensglobal.com', plusDays(monday, 1)));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Day options' })).getByText('Paste'));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenLastCalledWith(expect.objectContaining({ work_date: plusDays(monday, 1) })));
    fireEvent.doubleClick(cellOf('bob@greensglobal.com', plusDays(monday, 2)));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenLastCalledWith(expect.objectContaining({ work_date: plusDays(monday, 2) })));
    expect(screen.queryByRole('dialog')).toBeNull();   // a paste, not the editor
  });

  it('moves between days with the arrow keys, opens with Enter, deletes a draft with Delete', async () => {
    timeSchedule.mockResolvedValue(data([shift({ id: 'd1', email: 'bob@greensglobal.com', published: false })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const first = cellOf('amy@greensglobal.com');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cellOf('amy@greensglobal.com', plusDays(monday, 1)));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cellOf('bob@greensglobal.com', plusDays(monday, 1)));
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Add Shift' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const draft = blockOf('d1');
    draft.focus();
    fireEvent.keyDown(draft, { key: 'Delete' });
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('d1'));
  });

  it('opens the menu on a long press (touch); a block carries no hover icons', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.pointerDown(blockOf('s1'), { button: 0, clientX: 20, clientY: 20, pointerType: 'touch' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(await screen.findByRole('menu', { name: 'Shift options' }, { timeout: 1500 })).toBeTruthy();
    expect(timeSchedMove).not.toHaveBeenCalled();   // a touch never drags
    expect(blockOf('s1').querySelector('button')).toBeNull();   // no magnifier, no ⋯ on the block
  });

  it('sets a person\'s usual hours from their ⋯ menu, and says them once under the name', async () => {
    const d = data([shift()]);
    timeSchedule.mockResolvedValue({ ...d, usual: { 'amy@greensglobal.com': 'p1' } });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('[data-person="amy@greensglobal.com"]').textContent).toContain('Usual 9:00a - 5:00p');
    expect(document.querySelector('[data-person="bob@greensglobal.com"]').textContent).not.toContain('Usual');
    // Empty cells are empty: never a hint in a day.
    [0, 1, 2, 3, 4, 5, 6].forEach((i) => expect(cellOf('amy@greensglobal.com', plusDays(monday, i)).textContent).not.toContain('Usual'));
    // An empty day holds only the hidden ghost of their usual shift (shown on hover, placed on a click).
    const ghost = cellOf('amy@greensglobal.com', plusDays(monday, 1)).querySelector('[data-ghost]');
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.style.opacity).toBe('0');
    expect(cellOf('bob@greensglobal.com', plusDays(monday, 1)).querySelector('[data-ghost]')).toBeNull();
    expect(screen.getByText('Week · 8 Hrs')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Options for Bob Brown'));
    const menu = screen.getByRole('menu', { name: 'Options for Bob Brown' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Store · 9:00 AM - 5:00 PM/ }));
    await waitFor(() => expect(timeShiftAssign).toHaveBeenCalledWith({ shift_id: 'p1', emails: ['bob@greensglobal.com'] }));
  });
});

describe('The editor panel', () => {
  it('opens straight from a click on the block (no details step), beside the grid, and saves with Ctrl+Enter', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    expect(screen.queryByRole('dialog', { name: 'Shift Details' })).toBeNull();
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    expect(panel.tagName).toBe('ASIDE');
    expect(screen.getByText('Amy Adams')).toBeTruthy();                // the grid is still there
    expect(within(panel).getByRole('button', { name: /Store 9:00 AM - 5:00 PM/, pressed: true })).toBeTruthy();   // shift type chips
    fireEvent.change(within(panel).getByLabelText('Label'), { target: { value: 'Front Desk' } });
    fireEvent.keyDown(within(panel).getByLabelText('Label'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ label: 'Front Desk', group_id: '' })));
  });

  it('offers a labeled custom shift already on the schedule (e.g. All Properties) beside the shift types', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', shiftId: '', code: '', label: 'All Properties', start: '08:30', end: '17:30', ownColor: '#94a3b8' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    fireEvent.click(within(panel).getByRole('button', { name: /All Properties 8:30 AM - 5:30 PM/ }));
    expect(within(panel).getByLabelText('Start').value).toBe('08:30');
    expect(within(panel).getByLabelText('Label').value).toBe('All Properties');
    fireEvent.click(within(panel).getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ shift_id: '', start_hhmm: '08:30', end_hhmm: '17:30', label: 'All Properties', color: '#94a3b8' })));
  });

  it('keeps the times when a shift is switched to Custom', async () => {
    timeSchedule.mockResolvedValue(data([shift({ start: '10:00', end: '18:00' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Custom' }));
    expect(within(panel).getByLabelText('Start').value).toBe('10:00');
    expect(within(panel).getByLabelText('End').value).toBe('18:00');
  });

  it('gives a shift its own color', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    fireEvent.click(screen.getByLabelText('Color #dc2626'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ color: '#dc2626' })));
  });

  it('adds an unpaid activity, which sets the break and the paid hours', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    fireEvent.click(within(panel).getByText('Add Activity'));
    fireEvent.change(within(panel).getByLabelText('Activity 1 name'), { target: { value: 'Lunch' } });
    fireEvent.change(within(panel).getByLabelText('Activity 1 start'), { target: { value: '12:00' } });
    fireEvent.change(within(panel).getByLabelText('Activity 1 end'), { target: { value: '12:30' } });
    expect(within(panel).getByRole('button', { name: 'Unpaid', pressed: true })).toBeTruthy();   // new activities start unpaid
    expect(panel.textContent).toContain('7.5 Hrs');
    expect(panel.textContent).toContain('30m unpaid');
    fireEvent.click(within(panel).getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({
      break_min: 30, activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] })));
  });

  it('refuses a shift that starts and ends at the same time (QA D3)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ start: '10:00', end: '10:00' }), shift({ id: 's2', email: 'bob@greensglobal.com', code: 'BOB' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Week · 8 Hrs')).toBeTruthy();   // an old 10:00-10:00 row counts as 0 h
    fireEvent.doubleClick(blockOf('s1'));
    expect(screen.getByRole('alert').textContent).toBe("Start and end can't be the same time.");
    expect(screen.getByRole('button', { name: /^Save$/ }).disabled).toBe(true);
  });

  it('warns live but still lets it save', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedCheck.mockResolvedValue({ warnings: ['Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).'] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    expect(await screen.findByText('Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).')).toBeTruthy();
    expect(screen.getByText('You can still save this shift.')).toBeTruthy();
    expect(timeSchedCheck).toHaveBeenCalledWith(expect.objectContaining({ email: 'amy@greensglobal.com', exclude_id: 's1' }));
    expect(screen.getByRole('button', { name: /^Save$/ }).disabled).toBe(false);
  });

  it('explains a pending removal and can discard it; removing a shared shift waits for Share', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false, pendingDelete: true }), shift({ id: 's2', email: 'bob@greensglobal.com' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('s1'));
    expect(screen.getByText(/will be removed when you share/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByText('Discard Changes'));
    await waitFor(() => expect(timeSchedDiscard).toHaveBeenCalledWith('s1'));
    expect(toastOk).toHaveBeenCalledWith('Changes discarded.');
    fireEvent.doubleClick(blockOf('s2'));
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('s2'));
    // Said in the Undo bar (Undo discards the pending removal).
    expect((await screen.findByRole('status')).textContent).toContain("Marked for removal. It stays on the team's schedule until you share.");
  });

  it('switches to Time Off at the top and adds it for the person, approved', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(cellOf('amy@greensglobal.com'));
    const panel = screen.getByRole('dialog', { name: 'Add Shift' });
    fireEvent.click(within(panel).getByRole('tab', { name: 'Time Off' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add Time Off' }).querySelector('option[value="Jury Duty"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Time-off type'), { target: { value: 'Jury Duty' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep this confidential/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Time Off' }));
    await waitFor(() => expect(timeOffOnBehalf).toHaveBeenCalledWith({ employee_email: 'amy@greensglobal.com', type: 'Jury Duty',
      start_date: monday, end_date: monday, start_time: '', end_time: '', note: '', confidential: true }));
    await waitFor(() => expect(timeOffDecide).toHaveBeenCalledWith('t9', { status: 'approved', note: '' }));
    expect(toastOk).toHaveBeenCalledWith('Time off added for Amy Adams.');
  });

  it('gives a group scheduler no time off anywhere', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift()]), groupScheduler: true });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.contextMenu(blockOf('s1'));
    expect(screen.queryByText('Add Time Off')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(within(screen.getByRole('menu', { name: 'Add' })).queryByText('Time Off')).toBeNull();
  });

  it('edits an open shift and assigns it to a person by name', async () => {
    timeSchedule.mockResolvedValue(data([shift({ id: 'o1', email: '', openSlots: 2, code: 'OPEN' })]));
    const { api } = await import('../api');
    api.timeSchedAssign.mockResolvedValue({});
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.doubleClick(blockOf('o1'));
    const panel = screen.getByRole('dialog', { name: 'Edit Open Shift' });
    expect(within(panel).getByLabelText('People needed').value).toBe('2');
    fireEvent.change(within(panel).getByLabelText('Assign to'), { target: { value: 'bob@greensglobal.com' } });
    expect(panel.textContent).not.toContain('bob@greensglobal.com');
    fireEvent.click(within(panel).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(api.timeSchedAssign).toHaveBeenCalledWith('o1', 'bob@greensglobal.com'));
  });
});

describe('Views, options, export, drag', () => {
  it('switches to a Month calendar with time off and open counts, then opens a day', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ date: today }), shift({ id: 'o1', email: '', date: today, openSlots: 2, code: 'OPEN' })]),
      timeoff: [{ id: 't1', email: 'bob@greensglobal.com', startDate: today, endDate: today, type: 'vacation', status: 'approved' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByText('Month'));
    const t = new Date();
    const first = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`;
    const lastD = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(first, `${first.slice(0, 8)}${String(lastD).padStart(2, '0')}`));
    const day = await screen.findByLabelText(`Open ${formatUs(today)}`);
    expect(day.textContent).toContain('1 shift');
    expect(day.textContent).toContain('2 open');
    // Who is working and who is off show as faces (10/02); Bob is off all day.
    expect(day.querySelector('[title$=" - off"]')?.getAttribute('title')).toMatch(/^Bob .* - off$/);
    expect(day.querySelector('[title$=" - working"]')).toBeTruthy();
    fireEvent.click(day);
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(today, today));
    expect(await screen.findByLabelText(/^Shift 9:00 AM - 5:00 PM/)).toBeTruthy();
    expect(screen.getByText(/1 person · 8 Hrs/)).toBeTruthy();   // headcount and hours in the Day header
  });

  it('pastes a copied shift on a Day-view track (QA 25)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ date: today })]));
    const { container } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.mouseEnter(blockOf('s1'));
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    fireEvent.click(screen.getByText('Day'));
    await waitFor(() => expect(container.querySelector('[data-drop^="bob@greensglobal.com|"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-drop^="bob@greensglobal.com|"]'));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith(expect.objectContaining({ employee_email: 'bob@greensglobal.com', work_date: today, shift_id: 'p1' })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters people and shift types from View Options, and the hours follow', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', shiftId: 'p2', code: 'NGT', start: '21:00', end: '05:00' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Week · 16 Hrs')).toBeTruthy();
    const dlg = viewOptions();
    fireEvent.change(within(dlg).getByLabelText('Search people'), { target: { value: 'amy' } });
    expect(blockOf('s2')).toBeNull();
    expect(screen.getByText('Week · 8 Hrs')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Search people'), { target: { value: '' } });
    fireEvent.change(within(dlg).getByLabelText('Filter by shift type'), { target: { value: 'p2' } });
    expect(blockOf('s1')).toBeNull();
    expect(blockOf('s2')).toBeTruthy();
    fireEvent.click(within(dlg).getByText('Clear Filters'));
    expect(blockOf('s1')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Group people by'), { target: { value: 'shift' } });
    expect(document.querySelector('[data-type-row="Store"]').textContent).toContain('Amy Adams');
    expect(document.querySelector('[data-type-row="Night"]').textContent).toContain('Bob Brown');
  });

  it('hides Sunday and shows two weeks from View Options', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const sunday = plusDays(monday, 6);
    expect(screen.getByLabelText(`Open ${formatUs(sunday)}`)).toBeTruthy();
    const dlg = viewOptions();
    fireEvent.click(within(dlg).getByLabelText('Show Sunday'));
    expect(screen.queryByLabelText(`Open ${formatUs(sunday)}`)).toBeNull();
    fireEvent.click(within(dlg).getByLabelText('Two weeks at a time'));
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(monday, plusDays(monday, 13)));
  });

  // Weather Call (Oct 2026): a watched group with no work site cannot get a
  // forecast - its managers see one line until a site is set, and can hide it.
  it('tells managers which groups have no work site for the weather watch', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ groupId: 'g1' })]),
      groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true, workSiteId: 's1', siteLocated: true },
        { id: 'g2', name: 'Yard Crew', members: ['bob@greensglobal.com'], canEdit: true, workSiteId: '' },
        { id: 'g3', name: 'Office', members: [], canEdit: true, workSiteId: '', weatherAlerts: false }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const note = document.querySelector('[data-weather-setup]');
    expect(note.textContent).toContain('Yard Crew has no work site, so weather alerts cannot watch it.');
    expect(note.textContent).not.toContain('Office');          // the watch is off for it on purpose
    fireEvent.click(screen.getByRole('button', { name: 'Hide the weather setup note' }));
    expect(document.querySelector('[data-weather-setup]')).toBeNull();
  });

  // Weather Call (Oct 2026): the band the watch last wrote for a group-day
  // shows on the day header - the worst band among the groups on screen,
  // naming them - and quiet days carry nothing.
  it('shows the weather band on the day header for the groups in view', async () => {
    allTeams();
    timeSchedule.mockResolvedValue({ ...data([shift({ groupId: 'g1' }), shift({ id: 's2', email: 'bob@greensglobal.com', groupId: 'g2' })]),
      groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true }, { id: 'g2', name: 'Yard', members: ['bob@greensglobal.com'], canEdit: true }],
      weather: [
        { groupId: 'g1', date: monday, band: 'heads_up', chance: 45, inches: 0.12, windowStart: '9:00 AM', windowEnd: '5:00 PM' },
        { groupId: 'g2', date: monday, band: 'major', chance: 85, inches: 0.9, windowStart: '7:00 AM', windowEnd: '3:30 PM' },
        { groupId: 'g2', date: plusDays(monday, 1), band: 'quiet', chance: 5, inches: 0 },
      ] });
    weatherCallScreen.mockReset().mockResolvedValue({ group: { id: 'g2', name: 'Yard', workSiteName: '', deciders: [] }, date: monday, outlook: {}, roster: [], decision: null, canDecide: true, smsDefault: true });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const chips = document.querySelectorAll('[data-weather]');
    expect(chips.length).toBe(1);
    expect(chips[0].getAttribute('data-weather')).toBe('major');
    expect(chips[0].getAttribute('aria-label')).toBe('Major rain: 85% chance, 0.90 in during 7:00 AM - 3:30 PM (Front, Yard)');
    // A manager's click opens the Weather Call for the worst band's group.
    fireEvent.click(chips[0]);
    expect(await screen.findByRole('dialog', { name: 'Weather Call' })).toBeTruthy();
    await waitFor(() => expect(weatherCallScreen).toHaveBeenCalledWith('g2', monday));
  });

  it('shows a weather-cancelled shift struck through, unpaid', async () => {
    timeSchedule.mockResolvedValue(data([shift({ weatherStatus: 'cancelled', paidMin: 0 }), shift({ id: 's2', email: 'bob@greensglobal.com', weatherStatus: 'delayed', start: '10:00' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    const gone = blockOf('s1');
    expect(gone.getAttribute('data-weather-status')).toBe('cancelled');
    expect(gone.querySelector('[data-shift-time]').style.textDecoration).toBe('line-through');
    expect(gone.style.textDecoration).toBe('none');          // the "Weather - unpaid" tag is not struck
    expect(gone.textContent).toContain('Weather - unpaid');
    expect(gone.getAttribute('title')).toContain('Cancelled for weather (unpaid)');
    expect(blockOf('s2').getAttribute('title')).toContain('Start delayed for weather');
    expect(screen.getByText('Week · 7 Hrs')).toBeTruthy();   // Amy's cancelled day counts nothing; Bob's 10-5
  });

  it('exports what is on screen with the group and unpaid activities', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ breakMin: 30, groupId: 'g1', activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] })]),
      groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    exportMenu('Export to Excel');
    await waitFor(() => expect(exportExcel).toHaveBeenCalledTimes(1));
    const { columns, rows } = exportExcel.mock.calls[0][0];
    const row = Object.fromEntries(columns.map((c) => [c.header, c.get(rows[0])]));
    expect(row).toMatchObject({ Employee: 'Amy Adams', Group: 'Front', Start: '9:00 AM', End: '5:00 PM', 'Unpaid Break (min)': 30, 'Paid Hours': 7.5,
      Activities: '12:00 PM-12:30 PM Lunch (unpaid)', Status: 'Shared' });
  });

  it('prints the week in a new window, or says pop-ups are blocked', async () => {
    const doc = { write: vi.fn(), close: vi.fn() };
    const win = { document: doc, focus: vi.fn(), print: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(win);
    timeSchedule.mockResolvedValue(data([shift({ label: 'Front <desk>' })]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    exportMenu('Print');
    const html = doc.write.mock.calls[0][0];
    expect(html).toContain(`Schedule ${formatUs(monday)} - ${formatUs(plusDays(monday, 6))}`);
    expect(html).toContain('Amy Adams');
    expect(html).toContain('Front &lt;desk&gt;');
    expect(win.print).toHaveBeenCalled();
    open.mockReturnValue(null);
    exportMenu('Print');
    expect(toastErr).toHaveBeenCalledWith('Allow pop-ups for this site to print the schedule.');
    open.mockRestore();
  });

  it('imports shifts from a spreadsheet and lists what was skipped', async () => {
    sheetRows.current = [
      ['Date', 'Employee', 'Email', 'Start', 'End', 'Shift Type', 'Group'],
      ['11/16/2026', 'Amy Adams', 'amy@greensglobal.com', '9:00 AM', '5:00 PM', 'GST', 'Front'],
      ['11/17/2026', 'Bob Brown', '', '', '', 'GST', ''],
      ['someday', 'Amy Adams', '', '9:00 AM', '5:00 PM', '', ''],
    ];
    timeSchedImport.mockResolvedValue({ created: 1, errorCount: 1, errors: ['Row 3: that shift is already on the schedule.'] });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    more('Import');
    const file = new File(['x'], 'week.xlsx');
    file.arrayBuffer = async () => new ArrayBuffer(1);
    fireEvent.change(screen.getByLabelText('Schedule file'), { target: { files: [file] } });
    expect(await screen.findByText(/2 shifts ready to import · 1 row can't be read/)).toBeTruthy();
    fireEvent.click(screen.getByText('Import Shifts'));
    await waitFor(() => expect(timeSchedImport).toHaveBeenCalledWith({ rows: [
      expect.objectContaining({ row: 2, email: 'amy@greensglobal.com', date: '2026-11-16', start: '09:00', end: '17:00', shift: 'GST', group: 'Front' }),
      expect.objectContaining({ row: 3, email: 'bob@greensglobal.com', date: '2026-11-17', start: '', end: '' }),
    ] }));
    expect(await screen.findByText('Row 3: that shift is already on the schedule.')).toBeTruthy();
    expect(toastOk).toHaveBeenCalledWith('Added 1 shift as drafts. 1 row skipped. Share to send them.');
  });

  it('drags a shift to another person to move it, or copies with Ctrl', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    pointerDrag(blockOf('s1'), cellOf('bob@greensglobal.com'));
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', { employee_email: 'bob@greensglobal.com', work_date: monday, duplicate: false }));
    expect(screen.queryByRole('dialog')).toBeNull();   // the release did not open the day under it
    pointerDrag(blockOf('s1'), cellOf('bob@greensglobal.com'), { ctrlKey: true });
    await waitFor(() => expect(timeSchedMove).toHaveBeenLastCalledWith('s1', expect.objectContaining({ duplicate: true })));
    expect(toastOk).toHaveBeenCalledWith('Shift copied here as a draft.');
  });

  it('drags a shift to another person in Day view', async () => {
    timeSchedule.mockResolvedValue(data([shift({ date: today })]));
    const { container } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByText('Day'));
    await waitFor(() => expect(container.querySelector('[data-drop^="bob@greensglobal.com|"]')).toBeTruthy());
    pointerDrag(screen.getByLabelText(/^Shift 9:00 AM - 5:00 PM/), container.querySelector('[data-drop^="bob@greensglobal.com|"]'));
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', expect.objectContaining({ employee_email: 'bob@greensglobal.com', duplicate: false })));
  });

  it('a press without moving is a click, and never starts a drag', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.pointerDown(blockOf('s1'), { button: 0, clientX: 10, clientY: 10, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 11, clientY: 10 });
    fireEvent.doubleClick(blockOf('s1'));
    expect(await screen.findByRole('dialog', { name: 'Edit Shift' })).toBeTruthy();
    expect(timeSchedMove).not.toHaveBeenCalled();
  });

  it('a save keeps the grid on screen even when the parent passes new toast functions', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    const { rerender } = render(<ShiftSchedule toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Amy Adams');
    timeSchedule.mockClear();
    rerender(<ShiftSchedule toastOk={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Amy Adams')).toBeTruthy());
  });

  it('opens the details card from the menu, then the editor', async () => {
    timeSchedule.mockResolvedValue(data([shift({ label: 'Front', note: 'Keys at desk' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00pFront');   // the label is the only second line
    fireEvent.contextMenu(blockOf('s1'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Shift options' })).getByText('Details'));
    const card = screen.getByRole('dialog', { name: 'Shift Details' });
    expect(card.textContent).toContain('Keys at desk');
    expect(card.textContent).toContain(formatUs(monday));
    fireEvent.click(within(card).getByText('Edit Shift'));
    expect(await screen.findByRole('dialog', { name: 'Edit Shift' })).toBeTruthy();
  });

  it('adds a day note for everyone or a group; the note icon shows only once there is a note', async () => {
    timeSchedule.mockResolvedValue({ ...data([]), dayNotes: [{ date: plusDays(monday, 1), note: 'Stock count' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    const addBtn = await screen.findByLabelText(`Add a note for ${formatUs(monday)}`);
    expect(addBtn.style.opacity).toBe('0');                                    // hover reveals it
    expect(screen.getByLabelText(`Edit the note for ${formatUs(plusDays(monday, 1))}`).textContent).toContain('Stock count');
    fireEvent.click(addBtn);
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: 'Inventory day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(timeSchedDayNote).toHaveBeenCalledWith({ work_date: monday, note: 'Inventory day' }));
  });
});

describe('Share, copy, clear, discard', () => {
  it('shares a date range, says what waits and when it was last shared', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ published: false })]), lastPublishedAt: '2026-09-28T10:00:00Z', unsharedCount: 5 });
    timeSchedPublish.mockResolvedValue({ published: 3, added: 2, updated: 0, removed: 1, notified: 2 });
    timeSchedUnshared.mockResolvedValue({ count: 2, firstDate: monday, lastDate: monday });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Share, 5 unsaved' }));   // the count across the WHOLE schedule
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    expect(dlg.textContent).toContain('Last shared 09/28/2026');
    expect(await within(dlg).findByText('2 changes to share in these dates.')).toBeTruthy();
    expect(within(dlg).getByLabelText('Share from').value).toBe(monday);
    expect(within(dlg).getByLabelText('Share to').value).toBe(plusDays(monday, 6));
    fireEvent.change(within(dlg).getByLabelText('Share to'), { target: { value: plusDays(monday, 13) } });
    await waitFor(() => expect(timeSchedUnshared).toHaveBeenLastCalledWith(monday, plusDays(monday, 13)));
    fireEvent.click(within(dlg).getByText('The whole team'));
    // Phase 2: Review first, then Share from the review.
    fireEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await within(dlg).findByText('Review And Share');
    expect(timeSchedPublishReview).toHaveBeenCalledWith({ start: monday, end: plusDays(monday, 13) });
    expect(within(dlg).getByText('No warnings.')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(timeSchedPublish).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 13), notify: 'team', reason: '' }));
    expect(toastOk).toHaveBeenCalledWith('Shared with the team: 2 new, 1 removed. 2 people notified.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Schedule' })).toBeNull());
  });

  it('shows the server refusal in the review and keeps it open', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedPublish.mockRejectedValue(Object.assign(new Error('A reason is needed to share a schedule with warnings.'), { status: 400 }));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Share, 1 unsaved' }));
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await within(dlg).findByText('Review And Share');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Share' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('A reason is needed to share a schedule with warnings.');
    expect(toastErr).toHaveBeenCalledWith('A reason is needed to share a schedule with warnings.');
    expect(screen.getByRole('dialog', { name: 'Share Schedule' })).toBeTruthy();
  });

  it('jumps from a review warning to the cell on the grid and pulses it', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedPublishReview.mockResolvedValue({ changes: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', kind: 'added', date: monday, start: '09:00', end: '17:00', label: '', was: null }], people: 1,
      warnings: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', date: monday, shiftId: 's1', text: 'Only 6 hours of rest.', kind: 'rule' }], reasonRequired: false });
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Share, 1 unsaved' }));
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Review' }));
    await within(dlg).findByText('Review And Share');
    fireEvent.click(within(dlg).getByText('Only 6 hours of rest.'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share Schedule' })).toBeNull());
    await waitFor(() => expect(cellOf('amy@greensglobal.com').className).toContain('m-pulse-cell'));
  });

  it('refuses more than 92 days, and still counts locally on an older API', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedUnshared.mockRejectedValue(new Error('404'));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Share, 1 unsaved' }));
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    expect(within(dlg).getByText('1 change to share in these dates.')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Share to'), { target: { value: plusDays(monday, 100) } });
    expect(within(dlg).getByText('Share at most 92 days at a time.')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Review' }).disabled).toBe(true);
  });

  it('copies the week on screen to the next week as drafts', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    more('Copy Week');
    fireEvent.click(screen.getByLabelText('Copy approved time off too (as requests to approve)'));
    fireEvent.click(screen.getByText('Copy Shifts'));
    await waitFor(() => expect(timeSchedCopy).toHaveBeenCalledWith({
      source_start: monday, source_end: plusDays(monday, 6), target_start: plusDays(monday, 7), weeks: 1,
      include_open: true, include_notes: true, include_activities: true, skip_timeoff: true, overwrite: false, include_timeoff: true,
    }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/^Copied 4 shifts to .* as drafts · kept 1 existing\. Share to send them\.$/)));
  });

  it('clears the week and says what waits for Share', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    more('Clear Week');
    fireEvent.click(screen.getByText('Clear Shifts'));
    await waitFor(() => expect(timeSchedClear).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 6), include_open: true }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('2 drafts removed · 1 shared shift marked for removal until you share.'));
  });

  it('discards every unsaved change - new drafts too - after confirming, and not otherwise (Oct 28 2026)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ hasChanges: true }), shift({ id: 's2', email: 'bob@greensglobal.com', pendingDelete: true })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    confirmAsk.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledWith(expect.stringMatching(/^Discard 2 unsaved changes\? New shifts you placed are removed/), expect.objectContaining({ title: 'Discard Changes' })));
    expect(timeSchedDiscardAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(timeSchedDiscardAll).toHaveBeenCalledWith({ include_drafts: true }));
    expect(toastOk).toHaveBeenCalledWith('Discarded 2 unsaved changes.');
  });

  it('opens Requests from the More menu', async () => {
    timeSchedule.mockResolvedValue(data([]));
    const onOpenRequests = vi.fn();
    render(<ShiftSchedule toastOk={toastOk} onOpenRequests={onOpenRequests} />);
    await screen.findByText('Amy Adams');
    more('Requests');
    expect(onOpenRequests).toHaveBeenCalled();
  });
});

describe('Groups on the grid', () => {
  const teams = (over = {}) => ({
    ...data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', code: 'BOB', canEdit: false })]),
    employees: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', canEdit: true }, { email: 'bob@greensglobal.com', name: 'Bob Brown', canEdit: false }],
    groups: [{ id: 'g1', name: 'Construction', members: ['amy@greensglobal.com'], canEdit: true, archived: false, sortOrder: 1 },
      { id: 'g2', name: 'Office', members: ['bob@greensglobal.com'], canEdit: false, archived: false, sortOrder: 0 },
      { id: 'g3', name: 'Old Crew', members: [], canEdit: true, archived: true, sortOrder: 2 }],
    ...over,
  });

  it('orders groups as saved, switches from the team list, with archived groups apart', async () => {
    allTeams();
    timeSchedule.mockResolvedValue(teams());
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Bob Brown');
    const rows = [...document.querySelectorAll('[data-team]')].map((r) => r.getAttribute('data-team'));
    expect(rows).toEqual(['g2', 'g1']);                                   // sortOrder, not the alphabet
    expect(screen.queryByText('Old Crew')).toBeNull();
    fireEvent.click(screen.getByLabelText('Choose a team'));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toMatch(/^All Teams/);                               // first (Neil, Oct 28 2026)
    expect(names[1]).toMatch(/^Office/);                                  // then the saved order
    expect(names[2]).toMatch(/^Construction/);
    expect(names[3]).toMatch(/^Old Crew/);                                // archived, apart, under its own heading
    expect(screen.getByRole('listbox', { name: 'Teams' }).textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('option', { name: /Construction/ }));
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('Amy Adams')).toBeTruthy();
  });

  it("shows another group's people read-only", async () => {
    allTeams();
    timeSchedule.mockResolvedValue(teams());
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Bob Brown');
    expect(screen.getByText('View Only')).toBeTruthy();
    fireEvent.contextMenu(blockOf('s2'));
    expect(screen.queryByRole('menu', { name: 'Shift options' })).toBeNull();
    fireEvent.doubleClick(blockOf('s2'));
    const card = screen.getByRole('dialog', { name: 'Shift Details' });
    expect(within(card).queryByText('Edit Shift')).toBeNull();
    expect(screen.getAllByText('Add Members')).toHaveLength(1);
    // Add Members and ⋯ sit on the group row and appear on hover (always on touch).
    expect(screen.getByText('Add Members').closest('.group-tools').style.opacity).toBe('0');
    expect(screen.getByLabelText('Construction options').closest('.group-tools')).toBeTruthy();
  });

  it('adds members from the People list, by name', async () => {
    allTeams();
    timeSchedule.mockResolvedValue(teams());
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Bob Brown');
    fireEvent.click(screen.getByText('Add Members'));
    const dlg = await screen.findByRole('dialog', { name: 'Add Members' });
    fireEvent.click(await within(dlg).findByLabelText('Add Cat Cole'));
    expect(dlg.textContent).not.toContain('cat@greensglobal.com');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(timeShiftGroupMembers).toHaveBeenCalledWith('g1', { add: ['cat@greensglobal.com'] }));
  });

  it('archives a group from its menu, and flags anyone over 40 hours', async () => {
    const long = [0, 1, 2, 3, 4, 5].map((i) => shift({ id: `l${i}`, date: plusDays(monday, i), start: '08:00', end: '16:00' }));
    timeSchedule.mockResolvedValue(teams({ scheduled: long }));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText(/48 Hrs · over 40/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Construction options'));
    fireEvent.click(screen.getByText('Archive Group'));
    await waitFor(() => expect(timeShiftGroupMeta).toHaveBeenCalledWith('g1', { archived: true }));
  });

  it('asks for the LOCAL week, Monday or Sunday first as the settings say', async () => {
    timeSchedule.mockResolvedValue(data([]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await waitFor(() => expect(timeSchedule).toHaveBeenCalledWith(monday, plusDays(monday, 6)));
    unmount();
    timeSchedule.mockResolvedValue({ ...data([]), weekStart: 'sunday' });
    render(<ShiftSchedule toastOk={toastOk} />);
    // The Sunday-first week that holds TODAY: the Sunday before this
    // week's Monday - except on a Sunday, when it is today (this used to
    // say "Monday minus one" and failed every Sunday in CI).
    const sunday = plusDays(monday, new Date().getDay() === 0 ? 6 : -1);
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(sunday, plusDays(sunday, 6)));
  });
});

describe('On a phone', () => {
  it('collapses the toolbar to one row and shows a day list with a day strip, never a 7-column grid', async () => {
    const mm = asPhone();
    try {
      timeSchedule.mockResolvedValue({ ...data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', date: plusDays(monday, 1), published: false })]),
        groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com', 'bob@greensglobal.com'], canEdit: true }], dayNotes: [{ date: plusDays(monday, 1), note: 'Stock count' }] });
      render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
      await screen.findByText('Amy Adams');
      const bar = screen.getByRole('toolbar', { name: 'Schedule' });
      const names = within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
      // [‹ date ›] [+] [⋯] over [Team ▾] [Week ▾] (Oct 28 2026: the date leads, as on a computer).
      expect(names.map((n) => (/Pick a date$/.test(n) ? 'date' : n))).toEqual(['Previous week', 'date', 'Next week', 'Add', 'More', 'Choose a team', 'View']);
      expect(bar.querySelector('[data-range-caption]').textContent).toContain('This Week');
      expect(screen.queryByRole('columnheader')).toBeNull();                    // no 7-column grid
      const strip = screen.getByRole('tablist', { name: 'Day' });
      expect(within(strip).getAllByRole('tab')).toHaveLength(7);
      // The list opens on today; every person is one row with that day's blocks.
      expect(within(strip).getByRole('tab', { selected: true }).getAttribute('aria-label')).toContain(formatUs(today));
      expect(document.querySelector(`[data-cell="amy@greensglobal.com|${today}"]`)).toBeTruthy();
      fireEvent.click(within(strip).getByRole('tab', { name: new RegExp(formatUs(monday)) }));
      expect(blockOf('s1')).toBeTruthy();
      expect(blockOf('s2')).toBeNull();
      fireEvent.click(within(strip).getByRole('tab', { name: new RegExp(formatUs(plusDays(monday, 1))) }));
      expect(blockOf('s2')).toBeTruthy();
      expect(screen.getByText('Stock count')).toBeTruthy();
      // Save & Share and Discard lead ⋯ on a phone; the views under the Week menu; a block still opens the editor.
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      const items = within(screen.getByRole('menu', { name: 'More' })).getAllByRole('menuitem').map((b) => b.textContent.replace(/✓/g, '').trim());
      expect(items.slice(0, 2)).toEqual(['Save & Share (1)', 'Discard Changes']);
      expect(items).toContain('Copy Week');
      fireEvent.click(within(screen.getByRole('menu', { name: 'More' })).getByText('Save & Share (1)'));
      expect(screen.getByRole('dialog', { name: 'Share Schedule' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(screen.getByRole('button', { name: 'View' }));
      expect(within(screen.getByRole('menu', { name: 'View' })).getAllByRole('menuitem').map((b) => b.textContent.replace(/✓/g, '').trim())).toEqual(['Day', 'Week', 'Month']);
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(blockOf('s2'));
      expect(screen.getByRole('dialog', { name: 'Edit Shift' })).toBeTruthy();
    } finally { mm.mockRestore(); }
  });
});

// Actuals (Shifts Phase 1, Oct 14): what the clock said rides on the blocks
// as a bar and above the grid as the week's adherence line. Fetched beside
// the schedule, never blocking it; a failed call is simply no actuals.
describe('Actuals: the schedule meets the clock', () => {
  const actuals = () => ({
    // A Dubai shift (9:00 AM GST = 05:00 UTC): the hover reads its own clock wherever the manager is.
    cells: { [`amy@greensglobal.com|${monday}`]: { shiftId: 's1', status: 'late', firstIn: `${monday}T05:04:00`, lastOut: `${monday}T12:58:00`, workedMin: 474, lateMin: 4, earlyMin: 0, excuse: '', tz: 'Asia/Dubai' } },
    people: { 'amy@greensglobal.com': { scheduledMin: 480, workedMin: 474, late: 1, noShow: 0, leftEarly: 0, onTime: 0 },
      'bob@greensglobal.com': { scheduledMin: 480, workedMin: 0, late: 0, noShow: 1, leftEarly: 0, onTime: 0 } },
    totals: { scheduledMin: 960, workedMin: 474, late: 1, noShow: 1, leftEarly: 0, onTime: 0 },
  });
  it('draws the bar on the block and the adherence line above the grid, after the schedule', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedActuals.mockResolvedValue(actuals());
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalledWith(monday, plusDays(monday, 6)));
    const line = await screen.findByRole('status', { name: 'Week adherence' });
    expect(line.textContent).toBe('Scheduled 16h 00m · Worked 7h 54m · 1 Late · 1 No-Show');
    const bar = blockOf('s1').querySelector('[data-actual]');
    expect(bar.getAttribute('data-actual')).toBe('late');
    expect(bar.style.background).toBe('hsl(var(--color-orange))');
    expect(blockOf('s1').getAttribute('title')).toContain('Clocked in 9:04 AM (4 min late)\nClocked out 4:58 PM');
    expect(blockOf('s1').getAttribute('aria-label')).toBe('Shift 9:00 AM - 5:00 PM GST, Late');
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00pL');   // the bar and the letter badge are the only additions
    // The line follows the people on screen.
    const dlg = viewOptions();
    fireEvent.change(within(dlg).getByLabelText('Search people'), { target: { value: 'amy' } });
    expect(screen.getByRole('status', { name: 'Week adherence' }).textContent).toBe('Scheduled 8h 00m · Worked 7h 54m · 1 Late');
  });
  it('hides it all when Show Actuals is off, and says nothing when nothing was worked', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedActuals.mockResolvedValue(actuals());
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByRole('status', { name: 'Week adherence' });
    const dlg = viewOptions();
    fireEvent.click(within(dlg).getByLabelText('Show Actuals'));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Week adherence' })).toBeNull());
    expect(blockOf('s1').querySelector('[data-actual]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nexus.shifts.viewPrefs')).actuals).toBe(false);
    fireEvent.click(within(dlg).getByLabelText('Show Actuals'));
    await screen.findByRole('status', { name: 'Week adherence' });
    // Everything still ahead: counts of zero and nothing worked say nothing.
    fireEvent.click(within(dlg).getByRole('button', { name: 'Done' }));
    timeSchedActuals.mockResolvedValue({ cells: {}, people: { 'amy@greensglobal.com': { scheduledMin: 480, workedMin: 0, late: 0, noShow: 0, leftEarly: 0, onTime: 0 } }, totals: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Week adherence' })).toBeNull());
  });
  it('shows a viewer their bar but no week line, and a failed call changes nothing', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift()]), canManage: false });
    timeSchedActuals.mockResolvedValue(actuals());
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(blockOf('s1').querySelector('[data-actual]')).toBeTruthy());
    expect(screen.queryByRole('status', { name: 'Week adherence' })).toBeNull();
    unmount();
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedActuals.mockRejectedValue(new Error('API error 500'));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalled());
    expect(blockOf('s1').querySelector('[data-actual]')).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(toastErr).not.toHaveBeenCalled();
  });
  it('never asks for actuals on a week that is all ahead, and lays the line over the phone list too', async () => {
    timeSchedule.mockResolvedValue(data([shift({ date: plusDays(monday, 7) })]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedActuals).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(plusDays(monday, 7), plusDays(monday, 13)));
    await screen.findByText('Amy Adams');
    expect(timeSchedActuals).toHaveBeenCalledTimes(1);   // only this week asked; next week is all ahead
    expect(timeSchedActuals.mock.calls.every(([s]) => s === monday)).toBe(true);
    unmount();
    const mm = asPhone();
    try {
      timeSchedule.mockResolvedValue(data([shift()]));
      timeSchedActuals.mockResolvedValue(actuals());
      render(<ShiftSchedule toastOk={toastOk} />);
      const line = await screen.findByRole('status', { name: 'Week adherence' });
      expect(line.textContent).toContain('1 Late');
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${formatUs(monday)}`) }));   // the day the bar is on
      const list = screen.getByRole('list', { name: /Schedule for/ });
      expect(list.querySelector('[data-actual-word="late"]').textContent).toBe('Late');
      expect(list.querySelector('[data-shift="s1"] [data-actual]').getAttribute('data-actual')).toBe('late');
    } finally { mm.mockRestore(); }
  });
});

// Shifts Phase 3a (Oct 14): who has confirmed the schedules shared in view.
// GET /timeclock/schedule/confirmations answers { people: [...], unconfirmed }.
// The chip counts people, its list nudges the rest (one call per share),
// and the person column wears a 12px mark - green when every share in view
// is confirmed, hollow when one is not, nothing when no share asked them.
describe('Confirmations: the schedule comes to people', () => {
  const rows = () => [
    { email: 'amy@greensglobal.com', name: 'Amy Adams', unconfirmed: 0, publishes: [{ publishId: 'pub1', at: '2026-10-13T18:00:00Z', by: 'ada@greensglobal.com', confirmedAt: '2026-10-13T19:00:00Z', nudgedAt: null }] },
    { email: 'bob@greensglobal.com', name: 'Bob Brown', unconfirmed: 1, publishes: [
      { publishId: 'pub1', at: '2026-10-13T18:00:00Z', by: 'ada@greensglobal.com', confirmedAt: '2026-10-13T19:00:00Z', nudgedAt: null },
      { publishId: 'pub2', at: '2026-10-14T18:00:00Z', by: 'ada@greensglobal.com', confirmedAt: null, nudgedAt: null }] },
  ];
  const answer = (people) => ({ people, unconfirmed: people.reduce((n, p) => n + (p.unconfirmed || 0), 0) });
  it('counts the people, marks the person column, and nudges from the list', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com' })]));
    timeSchedConfirmations.mockResolvedValue(answer(rows()));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedConfirmations).toHaveBeenCalledWith(monday, plusDays(monday, 6)));
    const chip = await screen.findByRole('button', { name: '1 Of 2 Confirmed' });
    expect(chip.textContent).toBe('1 Of 2 Confirmed');
    const amy = document.querySelector('[data-person="amy@greensglobal.com"]');
    const bob = document.querySelector('[data-person="bob@greensglobal.com"]');
    expect(amy.querySelector('[data-confirm]').getAttribute('data-confirm')).toBe('all');
    expect(amy.querySelector('[data-confirm]').getAttribute('title')).toBe('Confirmed the shared schedule');
    expect(bob.querySelector('[data-confirm]').getAttribute('data-confirm')).toBe('some');
    expect(bob.querySelector('[data-confirm]').getAttribute('title')).toBe('Has not confirmed the shared schedule yet');
    expect(amy.querySelector('svg').getAttribute('width')).toBe('12');
    fireEvent.click(chip);
    const dlg = await screen.findByRole('dialog', { name: 'Schedule confirmations' });
    expect(dlg.textContent).toContain('Not Confirmed Yet');
    expect(within(dlg).queryByText('Amy Adams')).toBeNull();
    expect(within(dlg).getByText('Bob Brown')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Nudge Everyone' }));
    await waitFor(() => expect(timeSchedNudge).toHaveBeenCalledWith({ publish_id: 'pub2', emails: ['bob@greensglobal.com'] }));   // the LATEST share per person
    expect(toastOk).toHaveBeenCalledWith('Nudged 1 person.');
    // Nudged: the date in place of the button, and nothing left to nudge.
    await waitFor(() => expect(within(dlg).queryByRole('button', { name: 'Nudge Bob Brown' })).toBeNull());
    const today = new Date();
    expect(within(dlg).getByText(`Nudged ${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`)).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Nudge Everyone' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '1 Of 2 Confirmed' })).toBeTruthy();   // a nudge is not a confirmation
  });
  it('nudges one person, shows who was already nudged, and reads all-confirmed in green', async () => {
    const r = rows();
    r.push({ email: 'cat@greensglobal.com', name: 'Cat Cole', unconfirmed: 1, publishes: [{ publishId: 'pub2', at: '2026-10-14T18:00:00Z', by: 'ada@greensglobal.com', confirmedAt: null, nudgedAt: '2026-10-14T20:00:00Z' }] });
    timeSchedule.mockResolvedValue({ ...data([shift()]), employees: [...data([]).employees, { email: 'cat@greensglobal.com', name: 'Cat Cole' }] });
    timeSchedConfirmations.mockResolvedValue(answer(r));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    fireEvent.click(await screen.findByRole('button', { name: '1 Of 3 Confirmed' }));
    const dlg = await screen.findByRole('dialog', { name: 'Schedule confirmations' });
    expect(within(dlg).getByText('Nudged 10/14')).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: 'Nudge Cat Cole' })).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Nudge Bob Brown' }));
    await waitFor(() => expect(timeSchedNudge).toHaveBeenCalledWith({ publish_id: 'pub2', emails: ['bob@greensglobal.com'] }));
    await waitFor(() => expect(within(dlg).queryByRole('button', { name: 'Nudge Bob Brown' })).toBeNull());
    expect(timeSchedNudge).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule confirmations' })).toBeNull());
  });
  it('is green when everyone has confirmed; failed calls, a viewer and a range with no share show nothing', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedConfirmations.mockResolvedValue(answer([rows()[0]]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    const chip = await screen.findByRole('button', { name: '1 Of 1 Confirmed' });
    expect(chip.style.color).toBe('hsl(var(--color-green))');
    fireEvent.click(chip);
    expect((await screen.findByRole('dialog', { name: 'Schedule confirmations' })).textContent).toContain('Everyone Has Confirmed');
    unmount();
    timeSchedConfirmations.mockResolvedValue(answer([]));
    const r2 = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedConfirmations).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-confirm-chip]')).toBeNull();
    expect(document.querySelector('[data-confirm]')).toBeNull();
    r2.unmount();
    timeSchedConfirmations.mockRejectedValue(new Error('API error 500'));
    const r3 = render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    await waitFor(() => expect(timeSchedConfirmations).toHaveBeenCalledTimes(3));
    expect(document.querySelector('[data-confirm-chip]')).toBeNull();
    expect(toastErr).not.toHaveBeenCalled();
    r3.unmount();
    timeSchedule.mockResolvedValue({ ...data([shift()]), canManage: false });
    timeSchedConfirmations.mockResolvedValue(answer(rows()));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(timeSchedConfirmations).toHaveBeenCalledTimes(3);                 // a viewer never asks
    expect(document.querySelector('[data-confirm-chip]')).toBeNull();
  });
});
