import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { formatDateTime } from '../../lib/datetime';

// The shift panel's History (Shifts Phase 2, Oct 14): a saved shift lists
// what happened to it, newest first, with who, when, what changed and the
// reason it was shared with; a quiet empty state; nothing at all when the
// API cannot answer, and never loaded for a shift that is not saved yet.

const timeSchedCheck = vi.fn();
const timeSchedHistory = vi.fn();
vi.mock('../../api', () => ({
  api: {
    timeSchedCheck: (...a) => timeSchedCheck(...a),
    timeSchedHistory: (...a) => timeSchedHistory(...a),
    timeOffTypes: vi.fn().mockResolvedValue({ builtIn: ['vacation'], custom: [] }),
  },
}));

const { default: ShiftPanel, historyChangeText } = await import('./ShiftPanel');

const existing = { id: 's1', email: 'amy@x.com', date: '2026-10-20', start: '07:00', end: '15:30', label: 'GSV', shiftId: '', breakMin: 0, conflicts: [] };
const HISTORY = [
  { action: 'shared', actor: 'amy.lee@x.com', actorName: 'Amy Lee', at: '2026-10-14T22:12:00Z', before: { start: '08:00', end: '16:30', label: 'GSV' }, after: { start: '07:00', end: '15:30', label: 'GSV' }, reason: 'Overtime approved' },
  { action: 'edited', actor: 'amy.lee@x.com', actorName: 'Amy Lee', at: '2026-10-14T21:00:00Z', before: { start: '08:00', end: '16:30', label: 'GSV' }, after: { start: '07:00', end: '15:30', label: 'GSV' }, reason: '' },
  { action: 'weather', actor: 'bob@x.com', actorName: 'Bob Brown', at: '2026-10-13T15:00:00Z', before: null, after: null, reason: '' },
  { action: 'created', actor: 'amy.lee@x.com', actorName: '', at: '2026-10-10T15:00:00Z', before: null, after: { start: '08:00', end: '16:30', label: 'GSV' }, reason: '' },
];
const noop = () => {};
const open = (cell) => render(<ShiftPanel cell={cell} presets={[]} groups={[]} people={[]} nameOf={(e) => ({ 'amy@x.com': 'Amy Adams', 'bob@x.com': 'Bob Brown' }[e] || e)}
  onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);

beforeEach(() => {
  timeSchedCheck.mockReset().mockResolvedValue({ warnings: [] });
  timeSchedHistory.mockReset().mockResolvedValue({ shiftId: 's1', email: 'amy@x.com', date: '2026-10-20', entries: HISTORY });
});

describe('historyChangeText', () => {
  it('tells what changed in one line', () => {
    expect(historyChangeText({ start: '08:00', end: '16:30' }, { start: '07:00', end: '15:30' })).toBe('8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM');
    expect(historyChangeText({ start: '08:00', end: '16:30', label: 'Front' }, { start: '08:00', end: '16:30', label: 'Yard' })).toBe('Label: Front -> Yard');
    expect(historyChangeText({ start: '08:00', end: '16:30', date: '2026-10-20' }, { start: '08:00', end: '16:30', date: '2026-10-21' })).toBe('10/20/2026 -> 10/21/2026');
    expect(historyChangeText({ email: '' }, { email: 'amy@x.com' }, (e) => 'Amy Adams')).toBe('Open shift -> Amy Adams');
    expect(historyChangeText({ openSlots: 2 }, { openSlots: 1 })).toBe('2 -> 1 open');
    expect(historyChangeText(null, { start: '08:00', end: '16:30', label: 'GSV' })).toBe('8:00 AM - 4:30 PM · GSV');
    expect(historyChangeText({ start: '08:00', end: '16:30' }, null)).toBe('8:00 AM - 4:30 PM');
    expect(historyChangeText(null, null)).toBe('');
    expect(historyChangeText({ shiftId: 'a' }, { shiftId: 'b' })).toBe('Shift type changed');
  });
});

describe('ShiftPanel history', () => {
  it('lists the history of a saved shift newest first with who, when, the change and the reason', async () => {
    open({ email: 'amy@x.com', date: '2026-10-20', existing });
    const section = await waitFor(() => { const el = document.querySelector('[data-shift-history]'); if (!el) throw new Error('not yet'); return el; });
    expect(timeSchedHistory).toHaveBeenCalledWith('s1');
    const rows = [...section.querySelectorAll(':scope > div > div')].map((r) => r.textContent);
    expect(rows[0]).toBe(`Shared by Amy Lee · ${formatDateTime('2026-10-14T22:12:00Z')}8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM"Overtime approved"`);
    expect(rows[1]).toBe(`Edited by Amy Lee · ${formatDateTime('2026-10-14T21:00:00Z')}8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM`);
    expect(rows[2]).toBe(`Weather Call by Bob Brown · ${formatDateTime('2026-10-13T15:00:00Z')}`);
    expect(rows[3]).toBe(`Created by amy.lee@x.com · ${formatDateTime('2026-10-10T15:00:00Z')}8:00 AM - 4:30 PM · GSV`);
    expect(screen.getByText('History')).toBeTruthy();
  });

  it('says No history yet. for a shift with none', async () => {
    timeSchedHistory.mockResolvedValue({ shiftId: 's1', email: 'amy@x.com', date: '2026-10-20', entries: [] });
    open({ email: 'amy@x.com', date: '2026-10-20', existing });
    expect(await screen.findByText('No history yet.')).toBeTruthy();
  });

  it('shows nothing when the history cannot load, and never asks for a new shift', async () => {
    timeSchedHistory.mockRejectedValue(new Error('500'));
    const { unmount } = open({ email: 'amy@x.com', date: '2026-10-20', existing });
    await waitFor(() => expect(timeSchedHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[data-shift-history]')).toBeNull();
    expect(screen.queryByText('History')).toBeNull();
    unmount();
    timeSchedHistory.mockClear();
    open({ email: 'amy@x.com', date: '2026-10-20', existing: null });
    expect(screen.getByRole('dialog', { name: 'Add Shift' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(timeSchedHistory).not.toHaveBeenCalled();
  });
});

describe('ShiftPanel live check', () => {
  it('sends the unpaid break with the check, so the daily and weekly rules count paid minutes', async () => {
    // A 7:00 - 3:30 shift with a 30-minute lunch is 8h paid - without the
    // break the check read 8h 30m and warned of daily overtime that the
    // grid would never show once the shift was saved.
    open({ email: 'amy@x.com', date: '2026-10-20', existing: { ...existing, breakMin: 30 } });
    await waitFor(() => expect(timeSchedCheck).toHaveBeenCalled());
    expect(timeSchedCheck).toHaveBeenLastCalledWith({ email: 'amy@x.com', date: '2026-10-20', start: '07:00', end: '15:30', exclude_id: 's1', break_min: 30 });
  });

  it('takes a new shift\'s break from its shift type', async () => {
    const { unmount } = render(<ShiftPanel cell={{ email: 'amy@x.com', date: '2026-10-20' }} presets={[{ id: 'p1', name: 'Day', code: 'D', start: '07:00', end: '15:30', breakMin: 30, color: '#2563eb' }]} groups={[]} people={[]}
      nameOf={(e) => e} onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);
    await waitFor(() => expect(timeSchedCheck).toHaveBeenCalled());
    expect(timeSchedCheck).toHaveBeenLastCalledWith(expect.objectContaining({ start: '07:00', end: '15:30', break_min: 30 }));
    unmount();
  });
});
