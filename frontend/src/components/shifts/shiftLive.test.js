import { describe, it, expect } from 'vitest';
import { applyLive, draftFrom, movedTo, editedFields, spanMinutes } from './shiftLive';

const base = { scheduled: [
  { id: 'a', email: 'x@x.com', date: '2026-11-02', start: '09:00', end: '17:00', published: false, hasChanges: false },
  { id: 'b', email: 'x@x.com', date: '2026-11-03', start: '09:00', end: '17:00', published: true, hasChanges: false },
  { id: 'o', email: '', date: '2026-11-03', start: '10:00', end: '14:00', published: true, openSlots: 2 },
], openShifts: [] };

describe('applyLive', () => {
  it('leaves the schedule alone with nothing in flight', () => {
    expect(applyLive(base, [])).toBe(base);
    expect(applyLive(null, [{ adds: [{ id: 'z' }] }])).toBeNull();
  });

  it('removes a draft and marks a shared shift for removal, like the server', () => {
    const out = applyLive(base, [{ removes: [{ id: 'a', pending: false }, { id: 'b', pending: true }] }]);
    expect(out.scheduled.map((s) => s.id)).toEqual(['b', 'o']);
    expect(out.scheduled[0]).toMatchObject({ pendingDelete: true, published: false });
  });

  it('adds, replaces by id and keeps openShifts in step', () => {
    const out = applyLive(base, [{ adds: [{ id: 'n', email: '', date: '2026-11-04' }] }, { adds: [{ id: 'a', email: 'x@x.com', date: '2026-11-05' }] }]);
    expect(out.scheduled.filter((s) => s.id === 'a')).toHaveLength(1);
    expect(out.scheduled.find((s) => s.id === 'a').date).toBe('2026-11-05');
    expect(out.openShifts.map((s) => s.id)).toEqual(['o', 'n']);
  });

  it('lays patches over the shift', () => {
    const out = applyLive(base, [{ patches: [{ id: 'b', fields: { start: '08:00' } }] }]);
    expect(out.scheduled.find((s) => s.id === 'b').start).toBe('08:00');
  });
});

describe('the guesses', () => {
  it('draws a created shift from its payload and its shift type', () => {
    const s = draftFrom({ employee_email: 'X@x.com', work_date: '2026-11-04', shift_id: 'p1', group_id: 'g1' },
      [{ id: 'p1', name: 'Store', code: 'ST', start: '08:00', end: '16:30', breakMin: 30, color: '#123456' }]);
    expect(s).toMatchObject({ email: 'x@x.com', date: '2026-11-04', start: '08:00', end: '16:30', breakMin: 30, paidMin: 480,
      published: false, shiftName: 'Store', color: '#123456', groupId: 'g1', live: true, openSlots: 0 });
    expect(s.id).toMatch(/^live-/);
    expect(draftFrom({ employee_email: '', work_date: '2026-11-04', start_hhmm: '22:00', end_hhmm: '06:00', open_slots: 3 }))
      .toMatchObject({ openSlots: 3, paidMin: 480 });
  });

  it('moves a draft and leaves a shared original marked for removal; a copy leaves it alone', () => {
    const draft = movedTo(base.scheduled[0], 'y@x.com', '2026-11-06', false);
    expect(draft.adds[0]).toMatchObject({ email: 'y@x.com', date: '2026-11-06', published: false });
    expect(draft.removes).toEqual([{ id: 'a', pending: false }]);
    expect(movedTo(base.scheduled[1], 'x@x.com', '2026-11-06', false).removes).toEqual([{ id: 'b', pending: true }]);
    expect(movedTo(base.scheduled[1], 'x@x.com', '2026-11-06', true).removes).toEqual([]);
  });

  it('shows an edit to a shared shift as an unshared change', () => {
    expect(editedFields(base.scheduled[1], { start_hhmm: '07:00', end_hhmm: '15:00', break_min: 60 }))
      .toMatchObject({ start: '07:00', end: '15:00', paidMin: 420, hasChanges: true, published: false });
    expect(editedFields(base.scheduled[0], { color: '#ff0000' })).toMatchObject({ ownColor: '#ff0000', color: '#ff0000' });
    expect(editedFields(base.scheduled[0], {}).hasChanges).toBeUndefined();
  });

  it('counts an overnight span', () => {
    expect(spanMinutes('22:00', '06:00')).toBe(480);
    expect(spanMinutes('09:00', '17:00')).toBe(480);
  });
});
