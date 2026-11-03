import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { dueTrackState } from './ProgressTrack';
import { ProgressBar as GoalBar, goalTrackState } from '../performance/Goals';
import { checklistTrackState } from '../components/HrChecklists';
import { CourseRow, courseTrackState } from '../kb/training/MyTraining';
import { MyDayWidget } from '../tasks/homeWidgets';

// The screens that moved onto the one progress track (live accent,
// 11/02/2026): in progress orange, 100% green, overdue red.
const track = (c) => c.container.querySelector('.nx-track');

describe('dueTrackState', () => {
  it('is done at 1, overdue once the due day is before today, else live', () => {
    expect(dueTrackState(1, '2026-01-01', '2026-11-02')).toBe('done');
    expect(dueTrackState(0.4, '2026-11-01', '2026-11-02')).toBe('overdue');
    expect(dueTrackState(0.4, '2026-11-02', '2026-11-02')).toBe('live');
    expect(dueTrackState(0.4, '2026-11-01T00:00:00Z', '2026-11-02')).toBe('overdue');
    expect(dueTrackState(0.4, '', '2026-11-02')).toBe('live');
    expect(dueTrackState(0.4, null, '2026-11-02')).toBe('live');
  });
});

describe('Performance goals', () => {
  const today = '2026-11-02';
  it('reads done from the status or 100%, overdue from a past due date', () => {
    expect(goalTrackState({ value: 40, status: 'done', today })).toBe('done');
    expect(goalTrackState({ value: 100, status: 'on_track', today })).toBe('done');
    expect(goalTrackState({ value: 40, status: 'behind', dueOn: '2026-10-31', today })).toBe('overdue');
    expect(goalTrackState({ value: 40, status: 'behind', dueOn: '2026-12-31', today })).toBe('live');
    expect(goalTrackState({ value: 40, overdue: true, today })).toBe('overdue');
  });

  it('renders the track in its state', () => {
    const a = render(<GoalBar value={55} dueOn="2099-01-01" label="Sales goal progress" />);
    expect(track(a).className).toContain('is-live');
    expect(screen.getByRole('progressbar', { name: 'Sales goal progress' }).getAttribute('aria-valuenow')).toBe('55');
    a.unmount();
    const b = render(<GoalBar value={30} dueOn="2020-01-01" />);
    expect(track(b).className).toContain('is-overdue');
    b.unmount();
    const c = render(<GoalBar value={100} dueOn="2020-01-01" />);
    expect(track(c).className).toContain('is-done');
  });
});

describe('HR checklists', () => {
  it('is green when every step closed, red with a late step, gray when cancelled', () => {
    expect(checklistTrackState({ done: 9, total: 9, overdue: 0 })).toBe('done');
    expect(checklistTrackState({ done: 3, total: 9, overdue: 0, status: 'done' })).toBe('done');
    expect(checklistTrackState({ done: 3, total: 9, overdue: 2 })).toBe('overdue');
    expect(checklistTrackState({ done: 3, total: 9, overdue: 0 })).toBe('live');
    expect(checklistTrackState({ done: 3, total: 9, overdue: 2, status: 'cancelled' })).toBe('idle');
  });
});

describe('Training', () => {
  const base = { id: 'c1', title: 'Forklift Safety', code: 'FS-1', my_pct: 40, est_minutes: 20, due_date: '2026-11-20', days_overdue: 0, my_status: 'In Progress' };
  it('maps a course to its track state', () => {
    expect(courseTrackState(base)).toBe('live');
    expect(courseTrackState({ ...base, days_overdue: 3 })).toBe('overdue');
    expect(courseTrackState({ ...base, my_pct: 100, my_status: 'Completed' })).toBe('done');
    expect(courseTrackState({ ...base, my_pct: 100, my_status: 'Expired', days_overdue: 4 })).toBe('overdue');
  });

  it('draws an overdue course row in red', () => {
    const c = render(<CourseRow c={{ ...base, days_overdue: 3 }} onOpen={() => {}} />);
    expect(track(c).className).toContain('is-overdue');
    expect(screen.getByRole('progressbar', { name: 'Forklift Safety progress' }).getAttribute('aria-valuenow')).toBe('40');
  });
});

describe('Tasks Home My Day card', () => {
  it('is live while tasks are open and green once all are done', () => {
    const a = render(<MyDayWidget myDay={{ total: 3, done: [{ id: 'a' }], open: [] }} onOpenTask={() => {}} onToggle={() => {}} onOpenMyDay={() => {}} />);
    expect(track(a).className).toContain('is-live');
    expect(screen.getByRole('progressbar', { name: 'My Day progress' }).getAttribute('aria-valuetext')).toBe('1 of 3 done');
    a.unmount();
    const b = render(<MyDayWidget myDay={{ total: 2, done: [{ id: 'a' }, { id: 'b' }], open: [] }} onOpenTask={() => {}} onToggle={() => {}} onOpenMyDay={() => {}} />);
    expect(track(b).className).toContain('is-done');
  });
});
