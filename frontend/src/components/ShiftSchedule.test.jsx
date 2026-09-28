import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Shift schedule grid - unshared changes to PUBLISHED shifts (Sep 28, QA
// D1/D2). An edit or removal waits for Publish while the team keeps the
// published version; the scheduler's grid marks it, leaves a pending removal
// out of the hour totals, and can discard either.

const timeSchedule = vi.fn();
const timeSchedDelete = vi.fn();
const timeSchedDiscard = vi.fn();
const timeSchedPublish = vi.fn();
const timeSchedCheck = vi.fn();
const timeSchedCopy = vi.fn();
const timeSchedClear = vi.fn();
const shiftRequestsInbox = vi.fn();
const shiftRequestDecide = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeSchedule: (...a) => timeSchedule(...a),
    timeSchedDelete: (...a) => timeSchedDelete(...a),
    timeSchedDiscard: (...a) => timeSchedDiscard(...a),
    timeSchedPublish: (...a) => timeSchedPublish(...a), timeSchedCreate: vi.fn(), timeSchedUpdate: vi.fn(),
    timeSchedCheck: (...a) => timeSchedCheck(...a),
    timeSchedCopy: (...a) => timeSchedCopy(...a),
    timeSchedClear: (...a) => timeSchedClear(...a),
    shiftRequestsInbox: (...a) => shiftRequestsInbox(...a),
    shiftRequestDecide: (...a) => shiftRequestDecide(...a),
    shiftRequestSettingsSave: vi.fn(),
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
    shifts: [{ id: 'p1', code: 'GST', name: 'Store', start: '09:00', end: '17:00' }],
    groups: [], scheduled, timeoff: [], holidays: {}, canManage: true,
  };
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
});

describe('Shift requests inbox', () => {
  const req = { id: 'r1', kind: 'swap', status: 'pending_manager',
    summary: 'Amy Adams wants to swap 10/05/2026 9:00 AM - 5:00 PM for Bob Brown’s 10/06/2026 9:00 AM - 5:00 PM',
    requester: { email: 'amy@greensglobal.com', name: 'Amy Adams' }, target: { email: 'bob@greensglobal.com', name: 'Bob Brown' },
    note: 'Doctor visit', peerNote: '', createdAt: '2026-09-29T10:00:00' };

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

describe('Copy and Clear schedule', () => {
  it('copies the week on screen to the next week as drafts', async () => {
    timeSchedule.mockResolvedValue(data([shift()]));
    render(<ShiftSchedule toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('Copy Schedule'));
    fireEvent.click(screen.getByText('Copy Shifts'));
    await waitFor(() => expect(timeSchedCopy).toHaveBeenCalledWith({
      source_start: monday, source_end: plusDays(monday, 6), target_start: plusDays(monday, 7), weeks: 1,
      include_open: true, include_notes: true, skip_timeoff: true, overwrite: false,
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
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Shared with the team: 2 new, 1 removed. 2 people notified.'));
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
