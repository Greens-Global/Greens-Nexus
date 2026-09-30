import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, createEvent, within } from '@testing-library/react';

// Shift schedule grid - unshared changes to PUBLISHED shifts (Sep 28, QA
// D1/D2). An edit or removal waits for Publish while the team keeps the
// published version; the scheduler's grid marks it, leaves a pending removal
// out of the hour totals, and can discard either.

const timeSchedule = vi.fn();
const timeShiftAssign = vi.fn(async () => ({ ok: true, assigned: 1 }));
const timeSchedDelete = vi.fn();
const timeSchedDiscard = vi.fn();
const timeSchedPublish = vi.fn();
const timeSchedCheck = vi.fn();
const timeSchedCopy = vi.fn();
const timeSchedClear = vi.fn();
const shiftRequestsInbox = vi.fn();
const shiftRequestDecide = vi.fn();
const timeSchedMove = vi.fn();
const timeSchedDayNote = vi.fn();
const timeSchedUpdate = vi.fn();
const exportExcel = vi.fn();
const timeOffList = vi.fn();
const timeOffDecide = vi.fn();
const timeSchedDiscardAll = vi.fn();
const shiftRequestSettingsSave = vi.fn();
const confirmAsk = vi.fn();
const timeSchedImport = vi.fn();
const timeSchedCreate = vi.fn();
const timeOffTypes = vi.fn();
const timeOffTypesSave = vi.fn();
const timeOffOnBehalf = vi.fn();
const sheetRows = { current: [] };
vi.mock('xlsx', () => ({ read: () => ({ SheetNames: ['S'], Sheets: { S: {} } }), utils: { sheet_to_json: () => sheetRows.current } }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../tasks/exporting', () => ({ exportExcel: (...a) => exportExcel(...a) }));
vi.mock('../api', () => ({
  api: {
    timeSchedule: (...a) => timeSchedule(...a),
    timeShiftAssign: (...a) => timeShiftAssign(...a),
    timeSchedDelete: (...a) => timeSchedDelete(...a),
    timeSchedDiscard: (...a) => timeSchedDiscard(...a),
    timeSchedPublish: (...a) => timeSchedPublish(...a), timeSchedCreate: (...a) => timeSchedCreate(...a), timeSchedUpdate: (...a) => timeSchedUpdate(...a),
    timeSchedMove: (...a) => timeSchedMove(...a),
    timeOffList: (...a) => timeOffList(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    timeSchedDayNote: (...a) => timeSchedDayNote(...a),
    timeSchedCheck: (...a) => timeSchedCheck(...a),
    timeSchedCopy: (...a) => timeSchedCopy(...a),
    timeSchedClear: (...a) => timeSchedClear(...a),
    shiftRequestsInbox: (...a) => shiftRequestsInbox(...a),
    shiftRequestDecide: (...a) => shiftRequestDecide(...a),
    shiftRequestSettingsSave: (...a) => shiftRequestSettingsSave(...a),
    timeSchedDiscardAll: (...a) => timeSchedDiscardAll(...a),
    timeSchedImport: (...a) => timeSchedImport(...a),
    timeOffTypes: (...a) => timeOffTypes(...a),
    timeOffTypesSave: (...a) => timeOffTypesSave(...a),
    timeOffOnBehalf: (...a) => timeOffOnBehalf(...a),
    timeSchedAssign: vi.fn(), timeSchedBulk: vi.fn(),
  },
}));

const ShiftSchedule = (await import('./ShiftSchedule')).default;

// The grid opens on the current week, so the fixtures sit on its Monday.
const monday = (() => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

function formatUs(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function plusDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const shift = (over) => ({
  id: 's1', email: 'amy@greensglobal.com', date: monday, shiftId: 'p1', start: '09:00', end: '17:00',
  label: '', note: '', published: true, hasChanges: false, pendingDelete: false, openSlots: 0, code: 'GST', color: '#3b82f6',
  ...over,
});

function data(scheduled) {
  return {
    employees: [{ email: 'amy@greensglobal.com', name: 'Amy Adams' }, { email: 'bob@greensglobal.com', name: 'Bob Brown' }],
    shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00' },
      { id: 'p2', code: 'NGT', name: 'Night', start: '21:00', end: '05:00' }],
    groups: [], scheduled, timeoff: [], holidays: {}, canManage: true,
  };
}

// Drag by mouse (the grid's own drag, Sep 29): press, move, release over a
// day. jsdom has no layout, so the day under the pointer is stubbed.
function mouseDrag(from, to, keys = {}) {
  document.elementFromPoint = () => to;
  fireEvent.mouseDown(from, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(window, { clientX: 80, clientY: 40, ...keys });
  fireEvent.mouseUp(window, { clientX: 80, clientY: 40, ...keys });
  fireEvent.click(to);   // what the browser fires on release - must not open the day
}

const toastOk = vi.fn();
beforeEach(() => {
  timeSchedule.mockReset();
  timeSchedDelete.mockReset().mockResolvedValue({ ok: true, pending: true });
  timeSchedDiscard.mockReset().mockResolvedValue({});
  toastOk.mockReset();
  timeSchedCheck.mockReset().mockResolvedValue({ warnings: [] });
  timeSchedCopy.mockReset().mockResolvedValue({ created: 4, replaced: 0, skipped: 1, timeoffSkipped: 0,
    targetStart: plusDays(monday, 7), targetEnd: plusDays(monday, 13) });
  timeSchedClear.mockReset().mockResolvedValue({ removed: 2, pending: 1 });
  shiftRequestsInbox.mockReset().mockResolvedValue({ pending: [], recent: [], settings: { openShifts: true, swaps: true, offers: true } });
  shiftRequestDecide.mockReset().mockResolvedValue({});
  timeSchedMove.mockReset().mockResolvedValue({ moved: true, sourcePending: false });
  timeSchedDayNote.mockReset().mockResolvedValue({});
  timeSchedUpdate.mockReset().mockResolvedValue({});
  exportExcel.mockReset().mockResolvedValue();
  timeOffList.mockReset().mockResolvedValue([]);
  timeOffDecide.mockReset().mockResolvedValue({});
  timeSchedDiscardAll.mockReset().mockResolvedValue({ discarded: 2 });
  shiftRequestSettingsSave.mockReset().mockImplementation(async (c) => c);
  confirmAsk.mockReset().mockResolvedValue(true);
  timeSchedImport.mockReset().mockResolvedValue({ created: 2, errorCount: 0, errors: [] });
  timeSchedCreate.mockReset().mockResolvedValue({});
  timeOffTypes.mockReset().mockResolvedValue({ builtIn: ['vacation', 'sick', 'personal', 'unpaid', 'other'], custom: ['Jury Duty'], requestsOn: true });
  timeOffTypesSave.mockReset().mockImplementation(async (b) => ({ builtIn: [], custom: b.custom, requestsOn: true }));
  timeOffOnBehalf.mockReset().mockResolvedValue({ id: 't9' });
});

describe('Teams-style grid (Neil, Sep 29): photos, locations, shift menu, palette, keyboard', () => {
  const people = [{ email: 'amy@greensglobal.com', name: 'Amy Adams', photoUrl: 'https://x.supabase.co/amy.png', location: 'Escondido' },
    { email: 'bob@greensglobal.com', name: 'Bob Brown', photoUrl: '', location: '' }];
  const grid = (scheduled, over = {}) => ({ ...data(scheduled), employees: people, ...over });
  const cellOf = (email, day = monday) => document.querySelector(`[data-cell="${email}|${day}"]`);

  it('shows profile photos, with initials when there is none', async () => {
    timeSchedule.mockResolvedValue(grid([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    expect(document.querySelector('img[src="https://x.supabase.co/amy.png"]')).toBeTruthy();
    expect(screen.getByText('BB')).toBeTruthy();
  });

  it('groups people by location', async () => {
    timeSchedule.mockResolvedValue(grid([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    fireEvent.change(screen.getByLabelText('Group people by'), { target: { value: 'location' } });
    expect(screen.getByText('Escondido')).toBeTruthy();
    expect(screen.getByText('No location set')).toBeTruthy();
  });

  it('right-click menu: color, move to open shifts, delete', async () => {
    timeSchedule.mockResolvedValue(grid([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.contextMenu(await screen.findByText('GST'));
    const menu = screen.getByRole('menu', { name: 'Shift options' });
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.textContent.replace(/Ctrl\+.|▸/g, '').trim()))
      .toEqual(['Edit Shift', 'Add Shift', 'Add Time Off', 'Color', 'Move to Open Shifts', 'Copy', 'Paste', 'Delete']);
    fireEvent.click(screen.getByText('Color'));
    fireEvent.click(screen.getByLabelText('Color #16a34a'));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ color: '#16a34a', start_hhmm: '09:00' })));
    fireEvent.contextMenu(screen.getByText('GST'));
    fireEvent.click(screen.getByText('Move to Open Shifts'));
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', { employee_email: '', work_date: monday, duplicate: false }));
    fireEvent.contextMenu(screen.getByText('GST'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('s1'));
  });

  it('copies and pastes from the menu and with Ctrl+C / Ctrl+V', async () => {
    timeSchedule.mockResolvedValue(grid([shift({ breakMin: 30 })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    const chip = await screen.findByText('GST');
    fireEvent.mouseEnter(chip.closest('.sched-chip'));
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/^Shift copied/));
    fireEvent.mouseLeave(chip.closest('.sched-chip'));
    fireEvent.mouseEnter(cellOf('bob@greensglobal.com'));
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith(expect.objectContaining({
      employee_email: 'bob@greensglobal.com', work_date: monday, shift_id: 'p1', start_hhmm: '09:00', break_min: 30 })));
    fireEvent.contextMenu(cellOf('bob@greensglobal.com', plusDays(monday, 1)));
    const menu = screen.getByRole('menu', { name: 'Day options' });
    fireEvent.click(within(menu).getByText('Paste'));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenLastCalledWith(expect.objectContaining({ work_date: plusDays(monday, 1) })));
  });

  it('places a shift type dragged from the palette', async () => {
    timeSchedule.mockResolvedValue(grid([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('Amy Adams');
    mouseDrag(document.querySelector('[data-preset="NGT"]'), cellOf('bob@greensglobal.com'));
    await waitFor(() => expect(timeSchedCreate).toHaveBeenCalledWith({ employee_email: 'bob@greensglobal.com', work_date: monday, shift_id: 'p2' }));
    expect(toastOk).toHaveBeenCalledWith('NGT placed as a draft.');
  });

  it('counts conflicts, shows group hours and the time-off range and note', async () => {
    timeSchedule.mockResolvedValue(grid([shift({ conflicts: ['Overlaps another shift.'] })], {
      timeoff: [{ email: 'bob@greensglobal.com', startDate: monday, endDate: plusDays(monday, 1), type: 'vacation', status: 'pending', note: 'Yard sale' }] }));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText(/1 Conflict$/)).toBeTruthy();
    expect(screen.getByText('· 8 Hrs · 2 people')).toBeTruthy();
    expect(screen.getAllByText(`${formatUs(monday)} - ${formatUs(plusDays(monday, 1))}`).length).toBe(2);
    expect(screen.getAllByText('Yard sale').length).toBe(2);
  });
});

describe('Shift Types rows, print, import, time off from the grid, availability', () => {
  const toastErr = vi.fn();
  beforeEach(() => toastErr.mockReset());

  it('shows the week by shift type', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', shiftId: '', code: '' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    fireEvent.click(screen.getByText('Shift Types'));
    const store = document.querySelector('[data-type-row="Store"]');
    expect(store.textContent).toContain('Amy Adams');
    expect(document.querySelector('[data-type-row="Custom Times"]').textContent).toContain('Bob Brown');
    expect(document.querySelector('[data-type-row="Night"]')).toBeNull();   // no shifts, no row
  });

  it('prints the week in a new window, or says pop-ups are blocked', async () => {
    const doc = { write: vi.fn(), close: vi.fn() };
    const win = { document: doc, focus: vi.fn(), print: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(win);
    timeSchedule.mockResolvedValue(data([shift({ label: 'Front <desk>' })]));
    render(<ShiftSchedule toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('GST');
    fireEvent.click(screen.getByText('Print'));
    const html = doc.write.mock.calls[0][0];
    expect(html).toContain(`Schedule ${formatUs(monday)} - ${formatUs(plusDays(monday, 6))}`);
    expect(html).toContain('Amy Adams');
    expect(html).toContain('Front &lt;desk&gt;');
    expect(win.print).toHaveBeenCalled();
    open.mockReturnValue(null);
    fireEvent.click(screen.getByText('Print'));
    expect(toastErr).toHaveBeenCalledWith('Allow pop-ups for this site to print the schedule.');
    open.mockRestore();
  });

  it('imports shifts from a spreadsheet and lists what was skipped', async () => {
    sheetRows.current = [
      ['Date', 'Employee', 'Email', 'Start', 'End', 'Shift Type'],
      ['11/16/2026', 'Amy Adams', 'amy@greensglobal.com', '9:00 AM', '5:00 PM', 'GST'],
      ['11/17/2026', 'Bob Brown', '', '', '', 'GST'],
      ['someday', 'Amy Adams', '', '9:00 AM', '5:00 PM', ''],
    ];
    timeSchedImport.mockResolvedValue({ created: 1, errorCount: 1, errors: ['Row 3: that shift is already on the schedule.'] });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Import'));
    const file = new File(['x'], 'week.xlsx');
    file.arrayBuffer = async () => new ArrayBuffer(1);
    fireEvent.change(screen.getByLabelText('Schedule file'), { target: { files: [file] } });
    expect(await screen.findByText(/2 shifts ready to import · 1 row can't be read/)).toBeTruthy();
    fireEvent.click(screen.getByText('Import Shifts'));
    await waitFor(() => expect(timeSchedImport).toHaveBeenCalledWith({ rows: [
      expect.objectContaining({ row: 2, email: 'amy@greensglobal.com', date: '2026-11-16', start: '09:00', end: '17:00', shift: 'GST' }),
      expect.objectContaining({ row: 3, email: 'bob@greensglobal.com', date: '2026-11-17', start: '', end: '' }),
    ] }));
    expect(await screen.findByText('Row 3: that shift is already on the schedule.')).toBeTruthy();
    expect(toastOk).toHaveBeenCalledWith('Added 1 shift as drafts. 1 row skipped. Publish to share them.');
  });

  it('adds time off for a person from the grid and approves it', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    fireEvent.click(screen.getByText('Add Time Off'));
    const dialog = await screen.findByRole('dialog', { name: 'Add Time Off' });
    await waitFor(() => expect(dialog.querySelector('option[value="Jury Duty"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Time-off type'), { target: { value: 'Jury Duty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Time Off' }));
    await waitFor(() => expect(timeOffOnBehalf).toHaveBeenCalledWith({ employee_email: 'amy@greensglobal.com', type: 'Jury Duty',
      start_date: monday, end_date: monday, start_time: '', end_time: '', note: '', confidential: false }));
    await waitFor(() => expect(timeOffDecide).toHaveBeenCalledWith('t9', { status: 'approved', note: '' }));
    expect(toastOk).toHaveBeenCalledWith('Time off added for Amy Adams.');
  });

  it('marks people with limited availability', async () => {
    timeSchedule.mockResolvedValue({ ...data([]), availability: { 'amy@greensglobal.com': [{ weekday: 0, kind: 'unavailable', start: '', end: '', note: '' },
      { weekday: 1, kind: 'available', start: '08:00', end: '12:00', note: '' }] } });
    render(<ShiftSchedule toastOk={toastOk} />);
    const tag = await screen.findByText('Limited availability');
    expect(tag.getAttribute('title')).toBe('Availability: Mon unavailable · Tue 8:00 AM - 12:00 PM');
  });

  it('a group scheduler gets no time off or company settings', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift()]), groupScheduler: true });
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    expect(screen.queryByText('Add Time Off')).toBeNull();
    unmount();
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    await screen.findByRole('dialog', { name: 'Shift Requests' });
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('copies approved time off with the week when asked', async () => {
    timeSchedCopy.mockResolvedValue({ created: 1, replaced: 0, skipped: 0, timeoffSkipped: 0, timeoffCopied: 2,
      targetStart: plusDays(monday, 7), targetEnd: plusDays(monday, 13) });
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Copy Schedule'));
    fireEvent.click(screen.getByLabelText('Copy approved time off too (as requests to approve)'));
    fireEvent.click(screen.getByText('Copy Shifts'));
    await waitFor(() => expect(timeSchedCopy).toHaveBeenCalledWith(expect.objectContaining({ include_timeoff: true })));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith(expect.stringContaining('2 time-off requests to approve in Requests')));
  });

  it('lets admins turn time-off requests off and add reasons', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [], recent: [], settings: { openShifts: true, swaps: true, offers: true, teamSchedules: true, timeOffRequests: true } });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    fireEvent.click(await screen.findByLabelText('Staff can request time off'));
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenCalledWith(expect.objectContaining({ timeOffRequests: false })));
    expect(await screen.findByText('Jury Duty')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New time-off reason'), { target: { value: 'Bereavement' } });
    fireEvent.click(screen.getByText('Add Reason'));
    await waitFor(() => expect(timeOffTypesSave).toHaveBeenCalledWith({ custom: ['Jury Duty', 'Bereavement'] }));
    fireEvent.click(screen.getByLabelText('Remove Jury Duty'));
    await waitFor(() => expect(timeOffTypesSave).toHaveBeenLastCalledWith({ custom: ['Bereavement'] }));
  });
});

describe('Shift type filter, Discard Changes, shift color, reminder settings', () => {
  it('filters the grid to one shift type', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', shiftId: 'p2', code: 'NGT' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('NGT')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by shift type'), { target: { value: 'p1' } });
    expect(screen.queryByText('NGT')).toBeNull();
    expect(screen.getByText('GST')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear Filters'));
    expect(screen.getByText('NGT')).toBeTruthy();
  });

  it('discards every unpublished change after confirming', async () => {
    timeSchedule.mockResolvedValue(data([shift({ hasChanges: true }), shift({ id: 's2', email: 'bob@greensglobal.com', pendingDelete: true })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Discard Changes (2)'));
    await waitFor(() => expect(timeSchedDiscardAll).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 6) }));
    expect(confirmAsk).toHaveBeenCalledWith(expect.stringMatching(/^Discard 2 unpublished changes in this week\?/),
      expect.objectContaining({ title: 'Discard Changes' }));
    expect(toastOk).toHaveBeenCalledWith('Discarded 2 unpublished changes.');
  });

  it('does nothing when the discard is not confirmed, and hides with nothing to discard', async () => {
    confirmAsk.mockResolvedValue(false);
    timeSchedule.mockResolvedValue(data([shift({ hasChanges: true })]));
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Discard Changes (1)'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    expect(timeSchedDiscardAll).not.toHaveBeenCalled();
    unmount();
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    expect(screen.queryByText(/^Discard Changes/)).toBeNull();
  });

  it('gives a shift its own color', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    fireEvent.click(screen.getByLabelText('Color #dc2626'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ color: '#dc2626' })));
  });

  it('turns shift reminders off and changes the lead time', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [], recent: [],
      settings: { openShifts: true, swaps: true, offers: true, teamSchedules: true, reminders: true, reminderLeadMinutes: 60 } });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    fireEvent.change(await screen.findByLabelText('Reminder lead time'), { target: { value: '120' } });
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenCalledWith(expect.objectContaining({ reminderLeadMinutes: 120 })));
    fireEvent.click(screen.getByLabelText('Remind staff before a scheduled shift'));
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ reminders: false })));
    expect(screen.getByLabelText('Reminder lead time').disabled).toBe(true);
  });
});

describe('Views, filter, export, drag and drop, day notes, activities', () => {
  const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
  const lastOfMonth = () => {
    const d = new Date(); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  };

  it('switches to Month, then opens a day from it', async () => {
    // Today, not this week's Monday: in the first days of a month the Monday
    // belongs to the month before and is not on the Month grid (failed 10/01).
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    timeSchedule.mockResolvedValue(data([shift({ date: today })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    fireEvent.click(screen.getByText('Month'));
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(firstOfMonth(), lastOfMonth()));
    fireEvent.click(await screen.findByLabelText(`Open ${formatUs(today)}`));
    await waitFor(() => expect(timeSchedule).toHaveBeenLastCalledWith(today, today));
    expect(await screen.findByLabelText('Shift 9a to 5p')).toBeTruthy();
  });

  it('filters people by name, and the hours follow', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 's2', email: 'bob@greensglobal.com', code: 'BOB' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Week: 16 Hrs')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'amy' } });
    expect(screen.queryByText('BOB')).toBeNull();
    expect(screen.getByText('Week: 8 Hrs')).toBeTruthy();
  });

  it('exports what is on screen to Excel', async () => {
    timeSchedule.mockResolvedValue(data([shift({ breakMin: 30, activities: [{ start: '12:00', end: '13:00', label: 'Training' }] })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    fireEvent.click(screen.getByText('Export'));
    await waitFor(() => expect(exportExcel).toHaveBeenCalledTimes(1));
    const { columns, rows } = exportExcel.mock.calls[0][0];
    const row = Object.fromEntries(columns.map(c => [c.header, c.get(rows[0])]));
    expect(row).toMatchObject({ Employee: 'Amy Adams', Start: '9:00 AM', End: '5:00 PM', 'Unpaid Break (min)': 30,
      'Paid Hours': 7.5, Activities: '12:00 PM-1:00 PM Training', Status: 'Published' });
  });

  it('drags a shift to another person to move it, or copies with Ctrl', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    const { container } = render(<ShiftSchedule toastOk={toastOk} />);
    const chip = await screen.findByText('GST');
    const target = container.querySelector(`[data-cell="bob@greensglobal.com|${monday}"]`);
    mouseDrag(chip, target);
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', { employee_email: 'bob@greensglobal.com', work_date: monday, duplicate: false }));
    expect(screen.queryByRole('dialog')).toBeNull();   // the release did not open the day under it
    mouseDrag(await screen.findByText('GST'), target, { ctrlKey: true });
    await waitFor(() => expect(timeSchedMove).toHaveBeenLastCalledWith('s1', expect.objectContaining({ duplicate: true })));
    expect(toastOk).toHaveBeenCalledWith('Shift copied here as a draft.');
  });

  it('the grid never selects text, and shifts show Teams\' hover tools', async () => {
    timeSchedule.mockResolvedValue({ ...data([shift({ label: 'Front', note: 'Keys at desk' })]),
      timeoff: [{ email: 'bob@greensglobal.com', startDate: monday, endDate: monday, type: 'vacation', status: 'approved', note: '' }] });
    render(<ShiftSchedule toastOk={toastOk} />);
    const chip = (await screen.findByText('GST')).closest('.sched-chip');
    const grid = chip.closest('[style*="user-select"]');
    expect(grid.style.userSelect).toBe('none');
    const dragEvt = createEvent.dragStart(screen.getByText('Off'));
    fireEvent(screen.getByText('Off'), dragEvt);
    expect(dragEvt.defaultPrevented).toBe(true);              // a time-off card is never dragged as text
    fireEvent.click(within(chip).getByLabelText('Shift details'));
    const card = screen.getByRole('dialog', { name: 'Shift Details' });
    expect(card.textContent).toContain('Keys at desk');
    expect(card.textContent).toContain(`${formatUs(monday)}`);
    fireEvent.click(within(card).getByText('Edit Shift'));
    expect(await screen.findByText('Save')).toBeTruthy();
  });

  it('drags a shift to another person in Day view', async () => {
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    timeSchedule.mockResolvedValue(data([shift({ date: today })]));
    const { container } = render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    fireEvent.click(screen.getByText('Day'));
    await waitFor(() => expect(container.querySelector('[data-drop^="bob@greensglobal.com|"]')).toBeTruthy());
    const bar = screen.getByLabelText(/^Shift 9a to 5p/);
    const track = container.querySelector('[data-drop^="bob@greensglobal.com|"]');
    mouseDrag(bar, track);
    await waitFor(() => expect(timeSchedMove).toHaveBeenCalledWith('s1', expect.objectContaining({ employee_email: 'bob@greensglobal.com', duplicate: false })));
  });

  it('a save keeps the grid on screen even when the parent passes new toast functions', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    const { rerender } = render(<ShiftSchedule toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('GST');
    timeSchedule.mockClear();
    rerender(<ShiftSchedule toastOk={() => {}} toastErr={() => {}} />);   // what a toast in the parent does
    expect(screen.getByText('GST')).toBeTruthy();                        // no loader in between
    await waitFor(() => expect(screen.getByText('GST')).toBeTruthy());
  });

  it('a press without moving is a click, and never starts a drag', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    const chip = await screen.findByText('GST');
    const down = createEvent.mouseDown(chip, { button: 0, clientX: 10, clientY: 10 });
    fireEvent(chip, down);
    expect(down.defaultPrevented).toBe(true);           // no text selection starts
    fireEvent.mouseUp(window, { clientX: 11, clientY: 10 });
    fireEvent.click(chip);
    expect(await screen.findByText('Edit Shift')).toBeTruthy();
    expect(timeSchedMove).not.toHaveBeenCalled();
  });

  it('adds a day note', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(`Add a note for ${formatUs(monday)}`));
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: 'Inventory day' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(timeSchedDayNote).toHaveBeenCalledWith({ work_date: monday, note: 'Inventory day' }));
  });

  it('adds an activity to a shift', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    fireEvent.click(screen.getByText('Add Activity'));
    fireEvent.change(screen.getByLabelText('Activity 1 name'), { target: { value: 'Training' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(timeSchedUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({
      activities: [{ start: '09:00', end: '17:00', label: 'Training' }] })));
  });
});

describe('Shift requests inbox', () => {
  const req = { id: 'r1', kind: 'swap', status: 'pending_manager',
    summary: 'Amy Adams wants to swap 10/05/2026 9:00 AM - 5:00 PM for Bob Brown’s 10/06/2026 9:00 AM - 5:00 PM',
    requester: { email: 'amy@greensglobal.com', name: 'Amy Adams' }, target: { email: 'bob@greensglobal.com', name: 'Bob Brown' },
    note: 'Doctor visit', peerNote: '', createdAt: '2026-09-29T10:00:00' };

  it('lists time off with the shift requests and decides it', async () => {
    timeOffList.mockResolvedValue([{ id: 't1', email: 'amy@greensglobal.com', name: 'Amy Adams', type: 'vacation',
      startDate: '2026-10-05', endDate: '2026-10-06', startTime: '', endTime: '', note: 'Family trip', status: 'pending' }]);
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText('Requests, 1 waiting'));
    expect(await screen.findByText('Amy Adams · 10/05/2026 - 10/06/2026')).toBeTruthy();
    fireEvent.click(screen.getByText('Decline'));
    await waitFor(() => expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'rejected', note: '' }));
    expect(toastOk).toHaveBeenCalledWith('Time off declined. They were told.');
  });

  it('shows how many requests wait, and approves one with a note', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [req], recent: [], settings: { openShifts: true, swaps: true, offers: true } });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText('Requests, 1 waiting'));
    expect(await screen.findByText(/wants to swap/)).toBeTruthy();
    expect(screen.getByText('Amy Adams: “Doctor visit”')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note to the team'), { target: { value: 'OK this once' } });
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenCalledWith('r1', { approve: true, note: 'OK this once' }));
    expect(toastOk).toHaveBeenCalledWith('Approved. The schedule is updated and everyone involved was told.');
  });
});

describe('ShiftSchedule week dates', () => {
  it('asks for the LOCAL Monday-Sunday week, whatever the time zone', async () => {
    // Regression (Sep 29): dates came from toISOString(), so east of UTC the
    // whole grid was keyed a day early.
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    await waitFor(() => expect(timeSchedule).toHaveBeenCalledWith(monday, plusDays(monday, 6)));
  });
});

describe('Audit fixes (Sep 29): usual hours, company-wide settings, confidential time off', () => {
  it('shows usual hours faintly on a day with nothing placed, and never counts them', async () => {
    const d = data([shift()]);   // Amy has a shift on Monday only
    d.shifts[0].days = '1,2,3,4,5';
    timeSchedule.mockResolvedValue({ ...d, usual: { 'amy@greensglobal.com': 'p1' } });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    const tuesday = document.querySelector(`[data-cell="amy@greensglobal.com|${plusDays(monday, 1)}"]`);
    expect(tuesday.textContent).toContain('Usual 9a-5p');
    expect(document.querySelector(`[data-cell="amy@greensglobal.com|${monday}"]`).textContent).not.toContain('Usual');
    expect(document.querySelector(`[data-cell="amy@greensglobal.com|${plusDays(monday, 5)}"]`).textContent).not.toContain('Usual');   // Saturday
    expect(document.querySelector(`[data-cell="bob@greensglobal.com|${plusDays(monday, 1)}"]`).textContent).not.toContain('Usual');
    expect(screen.getByText('Week: 8 Hrs')).toBeTruthy();   // the one placed shift
  });

  it('puts one person on a preset from their row - usual hours per person, not only per group', async () => {
    const d = data([shift()]);
    timeSchedule.mockResolvedValue({ ...d, usual: { 'amy@greensglobal.com': 'p1' } });
    render(<ShiftSchedule toastOk={toastOk} />);
    await screen.findByText('GST');
    const pick = screen.getByLabelText('Usual hours for Bob Brown');
    expect(pick.value).toBe('');
    fireEvent.change(pick, { target: { value: 'p1' } });
    await waitFor(() => expect(timeShiftAssign).toHaveBeenCalledWith({ shift_id: 'p1', emails: ['bob@greensglobal.com'] }));
    // Taking someone off their preset sends an empty id.
    fireEvent.change(screen.getByLabelText('Usual hours for Amy Adams'), { target: { value: '' } });
    await waitFor(() => expect(timeShiftAssign).toHaveBeenCalledWith({ shift_id: '', emails: ['amy@greensglobal.com'] }));
  });

  it('offers the settings only to someone who can save them', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [], recent: [], settings: { openShifts: true, swaps: true, offers: true } });
    timeSchedule.mockResolvedValue({ ...data([shift()]), canConfigure: false });
    const { unmount } = render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    await screen.findByRole('dialog', { name: 'Shift Requests' });
    expect(screen.queryByText('Settings')).toBeNull();
    unmount();
    timeSchedule.mockResolvedValue({ ...data([shift()]), canConfigure: true });
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    expect(await screen.findByText('Settings')).toBeTruthy();
  });

  it('saves the visibility switches and the team time zone', async () => {
    shiftRequestsInbox.mockResolvedValue({ pending: [], recent: [], settings: { openShifts: true, swaps: true, offers: true,
      teamSchedules: true, teamShiftDetails: true, teamTimeOffReasons: false, timeZone: 'America/Los_Angeles' } });
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText(/^Requests/));
    fireEvent.click(await screen.findByLabelText('Staff can see why a teammate is off, and their note'));
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenCalledWith(expect.objectContaining({ teamTimeOffReasons: true })));
    const zone = screen.getByLabelText('Team time zone');
    const other = [...zone.options].map(o => o.value).find(v => v.startsWith('Asia/'));
    fireEvent.change(zone, { target: { value: other } });
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: other })));
  });

  it('adds confidential time off from the grid', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    fireEvent.click(screen.getByText('Add Time Off'));
    await screen.findByRole('dialog', { name: 'Add Time Off' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep this confidential/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Time Off' }));
    await waitFor(() => expect(timeOffOnBehalf).toHaveBeenCalledWith(expect.objectContaining({ confidential: true })));
  });

  it('can leave the activities out of a copy', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Copy Schedule'));
    fireEvent.click(screen.getByLabelText('Include shift activities'));
    fireEvent.click(screen.getByText('Copy Shifts'));
    await waitFor(() => expect(timeSchedCopy).toHaveBeenCalledWith(expect.objectContaining({ include_activities: false })));
  });
});

describe('Copy and Clear schedule', () => {
  it('copies the week on screen to the next week as drafts', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Copy Schedule'));
    fireEvent.click(screen.getByText('Copy Shifts'));
    await waitFor(() => expect(timeSchedCopy).toHaveBeenCalledWith({
      source_start: monday, source_end: plusDays(monday, 6), target_start: plusDays(monday, 7), weeks: 1,
      include_open: true, include_notes: true, include_activities: true, skip_timeoff: true, overwrite: false, include_timeoff: false,
    }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith(expect.stringMatching(/^Copied 4 shifts to .* as drafts · kept 1 existing\. Publish to share them\.$/)));
  });

  it('will not copy onto the dates it copies from', async () => {
    timeSchedule.mockResolvedValue(data([]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Copy Schedule'));
    const dialog = screen.getByRole('dialog', { name: 'Copy Schedule' });
    const paste = dialog.querySelectorAll('input[type="date"]')[2];
    fireEvent.change(paste, { target: { value: plusDays(monday, 2) } });
    expect(screen.getByText(/would land on the dates it copies from/)).toBeTruthy();
    expect(screen.getByText('Copy Shifts').closest('button').disabled).toBe(true);
  });

  it('clears the week and says what waits for publish', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Clear'));
    fireEvent.click(screen.getByText('Clear Shifts'));
    await waitFor(() => expect(timeSchedClear).toHaveBeenCalledWith({ start_date: monday, end_date: plusDays(monday, 6), include_open: true }));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('2 drafts removed · 1 published shift marked for removal until you publish.'));
  });
});

describe('ShiftSchedule unshared changes', () => {
  it('marks an edited and a removing shift, and leaves the removal out of the hours', async () => {
    timeSchedule.mockResolvedValue(data([
      shift({ id: 'a', published: false, hasChanges: true, start: '10:00', end: '18:00' }),
      shift({ id: 'b', email: 'bob@greensglobal.com', published: false, pendingDelete: true }),
    ]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Edited')).toBeTruthy();
    expect(screen.getByText('Removing')).toBeTruthy();
    // Only Amy's 8 hours count; Bob's shift is on its way out.
    expect(screen.getByText('Week: 8 Hrs')).toBeTruthy();
    expect(screen.getByText('Publish 2')).toBeTruthy();
  });

  it('explains a pending removal and can discard it', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false, pendingDelete: true })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Removing'));
    expect(screen.getByText(/will be removed when you publish/)).toBeTruthy();
    expect(screen.queryByText('Remove')).toBeNull();
    fireEvent.click(screen.getByText('Discard Changes'));
    await waitFor(() => expect(timeSchedDiscard).toHaveBeenCalledWith('s1'));
    expect(toastOk).toHaveBeenCalledWith('Changes discarded.');
  });

  it('counts people, not open shifts, and every open spot in the hours (QA D3)', async () => {
    timeSchedule.mockResolvedValue(data([shift(), shift({ id: 'o1', email: '', openSlots: 3, code: 'OPEN' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    // Amy's 8 h + three open spots of 8 h each; one person on the day, not two.
    expect(await screen.findByText('Week: 32 Hrs')).toBeTruthy();
    expect(screen.getByText('1 · 32 Hrs')).toBeTruthy();
  });

  it('refuses a shift that starts and ends at the same time (QA D3)', async () => {
    timeSchedule.mockResolvedValue(data([shift({ start: '10:00', end: '10:00' }), shift({ id: 's2', email: 'bob@greensglobal.com', code: 'BOB' })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    // An old 10:00-10:00 row counts as 0 h, not 24 h.
    expect(await screen.findByText('Week: 8 Hrs')).toBeTruthy();
    fireEvent.click(screen.getByText('GST'));
    expect(screen.getByRole('alert').textContent).toBe("Start and end can't be the same time.");
    expect(screen.getByText('Save').closest('button').disabled).toBe(true);
  });

  it('counts paid hours - the unpaid break is taken out', async () => {
    timeSchedule.mockResolvedValue(data([shift({ breakMin: 30 })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByText('Week: 7.5 Hrs')).toBeTruthy();
  });

  it('marks a shift that has a conflict, with the reason', async () => {
    timeSchedule.mockResolvedValue(data([shift({ conflicts: ['On approved time off that day (sick).'] })]));
    render(<ShiftSchedule toastOk={toastOk} />);
    expect(await screen.findByLabelText('Warning: On approved time off that day (sick).')).toBeTruthy();
  });

  it('warns live in the shift dialog but still lets it save', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    timeSchedCheck.mockResolvedValue({ warnings: ['Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).'] });
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    expect(await screen.findByText('Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026).')).toBeTruthy();
    expect(screen.getByText('You can still save this shift.')).toBeTruthy();
    expect(timeSchedCheck).toHaveBeenCalledWith(expect.objectContaining({ email: 'amy@greensglobal.com', exclude_id: 's1' }));
    expect(screen.getByText('Save').closest('button').disabled).toBe(false);
  });

  it('says how many people were notified when publishing', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedPublish.mockResolvedValue({ published: 3, added: 2, updated: 0, removed: 1, notified: 2 });
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Publish 1'));
    fireEvent.click(screen.getByText('Publish'));
    await waitFor(() => expect(timeSchedPublish).toHaveBeenCalledWith(expect.objectContaining({ notify: 'changed' })));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Shared with the team: 2 new, 1 removed. 2 people notified.'));
  });

  it('can tell the whole team when publishing', async () => {
    timeSchedule.mockResolvedValue(data([shift({ published: false })]));
    timeSchedPublish.mockResolvedValue({ published: 1, added: 1, updated: 0, removed: 0, notified: 5 });
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Publish 1'));
    fireEvent.click(screen.getByText('The whole team'));
    fireEvent.click(screen.getByText('Publish'));
    await waitFor(() => expect(timeSchedPublish).toHaveBeenCalledWith(expect.objectContaining({ notify: 'team' })));
  });

  it('says a removed published shift stays with the team until publish', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('GST'));
    expect(screen.queryByText('Discard Changes')).toBeNull();
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(timeSchedDelete).toHaveBeenCalledWith('s1'));
    expect(toastOk).toHaveBeenCalledWith("Marked for removal. It stays on the team's schedule until you publish.");
  });
});
