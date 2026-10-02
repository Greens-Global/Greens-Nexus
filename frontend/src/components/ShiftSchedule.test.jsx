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
vi.mock('../api', () => ({
  api: {
    timeSchedule: (...a) => timeSchedule(...a),
    timeShiftAssign: (...a) => timeShiftAssign(...a),
    timeSchedDelete: (...a) => timeSchedDelete(...a),
    timeSchedDiscard: (...a) => timeSchedDiscard(...a),
    timeSchedPublish: (...a) => timeSchedPublish(...a),
    timeSchedUnshared: (...a) => timeSchedUnshared(...a),
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
const viewOptions = () => { more('View Options'); return screen.getByRole('dialog', { name: 'View Options' }); };
const toastOk = vi.fn();
const toastErr = vi.fn();
// A 390px phone: the app's breakpoint hook reads matchMedia('(max-width: 640px)').
const asPhone = () => vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
  matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  toastOk.mockReset(); toastErr.mockReset();
  timeSchedule.mockReset();
  timeShiftGroupMembers.mockReset().mockResolvedValue({});
  timeShiftGroupMeta.mockReset().mockResolvedValue({});
  timeSchedDelete.mockReset().mockResolvedValue({ ok: true, pending: true });
  timeSchedDiscard.mockReset().mockResolvedValue({});
  timeSchedPublish.mockReset().mockResolvedValue({ published: 1, added: 1, notified: 1 });
  timeSchedUnshared.mockReset().mockResolvedValue({ count: 1 });
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
});

describe('Toolbar: one row, seven controls', () => {
  it('shows nav, views, group, Add, Share and More - and nothing else', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Amy Adams');
    const bar = screen.getByRole('toolbar', { name: 'Schedule' });
    const names = within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    expect(names).toEqual(['Previous week', 'Today', 'Next week', 'Day', 'Week', 'Month', 'Choose a group', 'Add', 'Share, 1 unshared', 'More']);
    expect(screen.queryByText('Fill Schedule')).toBeNull();
    expect(screen.queryByText('Publish 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const items = within(screen.getByRole('menu', { name: 'More' })).getAllByRole('menuitem').map((b) => b.textContent.trim());
    expect(items).toEqual(['Copy Week', 'Fill From Usual Hours', 'Clear Week', 'Import', 'Export', 'Print', 'View Options', 'Discard Changes', 'Requests']);
    const sw = within(screen.getByRole('menu', { name: 'More' })).getByRole('menuitemcheckbox', { name: /Hide People Without Shifts/ });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('shows an error with Retry when the schedule cannot load, with nothing offered on it', async () => {
    timeSchedule.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText(/The schedule could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.getByRole('button', { name: /^Share/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Amy Adams')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Share/ }).disabled).toBe(false);
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
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00pGST');
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
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00pGST');
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
    expect(blockOf('a').textContent).toBe('9:00a - 5:00pGST');
    expect(blockOf('b').getAttribute('aria-label')).toContain('Edited');
    expect(blockOf('b').querySelector('[title="Edited, not shared"]')).toBeTruthy();
    expect(blockOf('b').textContent).not.toContain('Edited');
    expect(blockOf('c').getAttribute('aria-label')).toContain('Removing');
    expect(blockOf('c').style.textDecoration).toBe('line-through');
    expect(screen.getByText('Week · 16 Hrs')).toBeTruthy();   // the removal is out
    expect(screen.getByRole('button', { name: 'Share, 3 unshared' })).toBeTruthy();
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

  it('marks people with limited availability, and a conflict on a shift', async () => {
    timeSchedule.mockResolvedValue({ ...grid([shift({ conflicts: ['On approved time off that day (sick).'] })]),
      availability: { 'amy@greensglobal.com': [{ weekday: 0, kind: 'unavailable', start: '', end: '', note: '' }, { weekday: 1, kind: 'available', start: '08:00', end: '12:00', note: '' }] } });
    render(<ShiftSchedule toastOk={toastOk} />);
    const tag = await screen.findByText('Limited Availability');
    expect(tag.getAttribute('title')).toBe('Availability: Mon unavailable · Tue 8:00 AM - 12:00 PM');
    expect(screen.getByLabelText('Warning: On approved time off that day (sick).')).toBeTruthy();
  });
});

describe('The week grid engine (WeekGrid, 10/02)', () => {
  const groups2 = (scheduled, over = {}) => ({ ...data(scheduled),
    groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true, sortOrder: 0 },
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

  it('folds groups with nothing this week, says so in one row, and remembers what the user opens', async () => {
    timeSchedule.mockResolvedValue(groups2([shift()]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('1 person · no shifts this week')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Back' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-open-row="g2"]')).toBeNull();    // a folded group shows nothing under it
    expect(document.querySelector('[data-open-row="g1"]')).toBeTruthy();  // a manager gets the slim Open Shifts row
    fireEvent.click(screen.getByRole('button', { name: 'Expand Back' }));
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    unmount();
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Bob Brown')).toBeTruthy();         // remembered
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Front' }));
    expect(screen.queryByText('Amy Adams')).toBeNull();
  });

  it('keeps a group open when someone in it is off, and never shows a viewer an empty Open Shifts row', async () => {
    timeSchedule.mockResolvedValue({ ...groups2([shift()]), canManage: false,
      timeoff: [{ id: 'v1', email: 'bob@greensglobal.com', startDate: monday, endDate: plusDays(monday, 1), type: 'vacation', status: 'approved' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    expect(document.querySelector('[data-open-row]')).toBeNull();
  });

  it('hides people without shifts from the ⋯ menu, and remembers it', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'More' })).getByRole('menuitemcheckbox', { name: /Hide People Without Shifts/ }));
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    unmount();
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(screen.queryByText('Bob Brown')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(within(screen.getByRole('menu', { name: 'More' })).getByRole('menuitemcheckbox', { name: /Hide People Without Shifts/ }).getAttribute('aria-checked')).toBe('true');
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
    fireEvent.click(within(menu).getByText(/NGT · 9:00 PM - 5:00 AM/));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith({ employee_email: 'bob@greensglobal.com', work_date: monday, shift_id: 'p2', group_id: '' }));
    expect(toastOk).toHaveBeenCalledWith('NGT placed as a draft.');
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
    fireEvent.click(cellOf('bob@greensglobal.com', plusDays(monday, 2)));
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
    expect(cellOf('amy@greensglobal.com', plusDays(monday, 1)).textContent).toBe('');
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
    fireEvent.click(blockOf('s1'));
    expect(screen.queryByRole('dialog', { name: 'Shift Details' })).toBeNull();
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    expect(panel.tagName).toBe('ASIDE');
    expect(screen.getByText('Amy Adams')).toBeTruthy();                // the grid is still there
    expect(within(panel).getByRole('button', { name: /GST 9:00 AM - 5:00 PM/, pressed: true })).toBeTruthy();   // shift type chips
    fireEvent.change(within(panel).getByLabelText('Label'), { target: { value: 'Front Desk' } });
    fireEvent.keyDown(within(panel).getByLabelText('Label'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ label: 'Front Desk', group_id: '' })));
  });

  it('gives a shift its own color', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(blockOf('s1'));
    fireEvent.click(screen.getByLabelText('Color #dc2626'));
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ color: '#dc2626' })));
  });

  it('adds an unpaid activity, which sets the break and the paid hours', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(blockOf('s1'));
    const panel = screen.getByRole('dialog', { name: 'Edit Shift' });
    fireEvent.click(within(panel).getByText('Add Activity'));
    fireEvent.change(within(panel).getByLabelText('Activity 1 name'), { target: { value: 'Lunch' } });
    fireEvent.change(within(panel).getByLabelText('Activity 1 start'), { target: { value: '12:00' } });
    fireEvent.change(within(panel).getByLabelText('Activity 1 end'), { target: { value: '12:30' } });
    expect(within(panel).getByRole('button', { name: 'Unpaid', pressed: true })).toBeTruthy();   // new activities start unpaid
    expect(panel.textContent).toContain('7.5 Hrs');
    expect(panel.textContent).toContain('30m unpaid');
    fireEvent.click(within(panel).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({
      break_min: 30, activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] })));
  });

  it('refuses a shift that starts and ends at the same time (QA D3)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ start: '10:00', end: '10:00' }), shift({ id: 's2', email: 'bob@greensglobal.com', code: 'BOB' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Week · 8 Hrs')).toBeTruthy();   // an old 10:00-10:00 row counts as 0 h
    fireEvent.click(blockOf('s1'));
    expect(screen.getByRole('alert').textContent).toBe("Start and end can't be the same time.");
    expect(screen.getByRole('button', { name: /^Save/ }).disabled).toBe(true);
  });

  it('warns live but still lets it save', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedCheck.mockResolvedValue({ warnings: ['Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).'] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(blockOf('s1'));
    expect(await screen.findByText('Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).')).toBeTruthy();
    expect(screen.getByText('You can still save this shift.')).toBeTruthy();
    expect(timeSchedCheck).toHaveBeenCalledWith(expect.objectContaining({ email: 'amy@greensglobal.com', exclude_id: 's1' }));
    expect(screen.getByRole('button', { name: /^Save/ }).disabled).toBe(false);
  });

  it('explains a pending removal and can discard it; removing a shared shift waits for Share', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false, pendingDelete: true }), shift({ id: 's2', email: 'bob@greensglobal.com' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(blockOf('s1'));
    expect(screen.getByText(/will be removed when you share/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByText('Discard Changes'));
    await waitFor(() => expect(timeSchedDiscard).toHaveBeenCalledWith('s1'));
    expect(toastOk).toHaveBeenCalledWith('Changes discarded.');
    fireEvent.click(blockOf('s2'));
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('s2'));
    expect(toastOk).toHaveBeenCalledWith("Marked for removal. It stays on the team's schedule until you share.");
  });

  it('switches to Time Off at the top and adds it for the person, approved', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(cellOf('amy@greensglobal.com'));
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
    fireEvent.click(blockOf('o1'));
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
    expect(day.textContent).toContain('Bob off');
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

  it('exports what is on screen with the group and unpaid activities', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ breakMin: 30, groupId: 'g1', activities: [{ start: '12:00', end: '12:30', label: 'Lunch', paid: false }] })]),
      groups: [{ id: 'g1', name: 'Front', members: ['amy@greensglobal.com'], canEdit: true }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    more('Export');
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
    more('Print');
    const html = doc.write.mock.calls[0][0];
    expect(html).toContain(`Schedule ${formatUs(monday)} - ${formatUs(plusDays(monday, 6))}`);
    expect(html).toContain('Amy Adams');
    expect(html).toContain('Front &lt;desk&gt;');
    expect(win.print).toHaveBeenCalled();
    open.mockReturnValue(null);
    more('Print');
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
    fireEvent.click(blockOf('s1'));
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
    expect(blockOf('s1').textContent).toBe('9:00a - 5:00pGSTFront');   // the label is the only second line
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
    fireEvent.click(screen.getByRole('button', { name: 'Share, 5 unshared' }));   // the count across the WHOLE schedule
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    expect(dlg.textContent).toContain('Last shared 09/28/2026');
    expect(await within(dlg).findByText('2 changes to share in these dates.')).toBeTruthy();
    expect(within(dlg).getByLabelText('Share from').value).toBe(monday);
    expect(within(dlg).getByLabelText('Share to').value).toBe(plusDays(monday, 6));
    fireEvent.change(within(dlg).getByLabelText('Share to'), { target: { value: plusDays(monday, 13) } });
    await waitFor(() => expect(timeSchedUnshared).toHaveBeenLastCalledWith(monday, plusDays(monday, 13)));
    fireEvent.click(within(dlg).getByText('The whole team'));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(timeSchedPublish).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 13), notify: 'team' }));
    expect(toastOk).toHaveBeenCalledWith('Shared with the team: 2 new, 1 removed. 2 people notified.');
  });

  it('refuses more than 92 days, and still counts locally on an older API', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedUnshared.mockRejectedValue(new Error('404'));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.click(screen.getByRole('button', { name: 'Share, 1 unshared' }));
    const dlg = screen.getByRole('dialog', { name: 'Share Schedule' });
    expect(within(dlg).getByText('1 change to share in these dates.')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Share to'), { target: { value: plusDays(monday, 100) } });
    expect(within(dlg).getByText('Share at most 92 days at a time.')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Share' }).disabled).toBe(true);
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

  it('discards every unshared change after confirming, and not otherwise', async () => {
    timeSchedule.mockResolvedValue(data([shift({ hasChanges: true }), shift({ id: 's2', email: 'bob@greensglobal.com', pendingDelete: true })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    confirmAsk.mockResolvedValueOnce(false);
    more('Discard Changes (2)');
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledWith(expect.stringMatching(/^Discard 2 unshared changes in this week\?/), expect.objectContaining({ title: 'Discard Changes' })));
    expect(timeSchedDiscardAll).not.toHaveBeenCalled();
    more('Discard Changes (2)');
    await waitFor(() => expect(timeSchedDiscardAll).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 6) }));
    expect(toastOk).toHaveBeenCalledWith('Discarded 2 unshared changes.');
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

  it('orders groups as saved, filters from the group list, with archived groups apart', async () => {
    timeSchedule.mockResolvedValue(teams());
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Bob Brown');
    const rows = [...document.querySelectorAll('[data-team]')].map((r) => r.getAttribute('data-team'));
    expect(rows).toEqual(['g2', 'g1']);                                   // sortOrder, not the alphabet
    expect(screen.queryByText('Old Crew')).toBeNull();
    fireEvent.click(screen.getByLabelText('Choose a group'));
    fireEvent.click(screen.getByRole('option', { name: /Construction/ }));
    expect(screen.queryByText('Bob Brown')).toBeNull();
    expect(screen.getByText('Amy Adams')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Choose a group'));
    fireEvent.click(screen.getByRole('tab', { name: 'Archived Groups' }));
    expect(screen.getByRole('option', { name: /Old Crew/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Office/ })).toBeNull();
  });

  it("shows another group's people read-only", async () => {
    timeSchedule.mockResolvedValue(teams());
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Bob Brown');
    expect(screen.getByText('View Only')).toBeTruthy();
    fireEvent.contextMenu(blockOf('s2'));
    expect(screen.queryByRole('menu', { name: 'Shift options' })).toBeNull();
    fireEvent.click(blockOf('s2'));
    const card = screen.getByRole('dialog', { name: 'Shift Details' });
    expect(within(card).queryByText('Edit Shift')).toBeNull();
    expect(screen.getAllByText('Add Members')).toHaveLength(1);
    // Add Members and ⋯ sit on the group row and appear on hover (always on touch).
    expect(screen.getByText('Add Members').closest('.group-tools').style.opacity).toBe('0');
    expect(screen.getByLabelText('Construction options').closest('.group-tools')).toBeTruthy();
  });

  it('adds members from the People list, by name', async () => {
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
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(plusDays(monday, -1), plusDays(monday, 5)));
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
      expect(names).toEqual(['Previous week', 'Today', 'Next week', 'View', 'Add', 'More']);
      expect(bar.textContent).toContain(`${formatUs(monday)} - ${formatUs(plusDays(monday, 6))}`);
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
      // Share and the group picker live under ⋯; the views under the Week menu; a block still opens the editor.
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      const items = within(screen.getByRole('menu', { name: 'More' })).getAllByRole('menuitem').map((b) => b.textContent.replace(/✓/g, '').trim());
      expect(items.slice(0, 3)).toEqual(['Share (1)', 'All Groups', 'Front']);
      expect(items).toContain('Copy Week');
      fireEvent.click(within(screen.getByRole('menu', { name: 'More' })).getByText('Share (1)'));
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
