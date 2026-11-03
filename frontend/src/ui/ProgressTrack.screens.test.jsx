import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { dueTrackState, countTrackState } from './ProgressTrack';
import { ProgressBar as GoalBar, goalTrackState } from '../performance/Goals';
import { checklistTrackState, behindPhases, WarnNote } from '../components/HrChecklists';
import { ProgressBar as PortfolioBar, phoneColumns } from '../tasks/PortfoliosView';
import { ProjectsAtRiskWidget } from '../tasks/homeWidgets';
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

describe('countTrackState (review 1 and 7)', () => {
  const today = '2026-11-02';
  it('reads the counts, never a rounded percent', () => {
    // 199 of 200 rounds to 100% but is not done - and past due it is red.
    expect(countTrackState({ done: 199, total: 200, dueISO: '2026-10-01', todayISO: today })).toBe('overdue');
    expect(countTrackState({ done: 199, total: 200, todayISO: today })).toBe('live');
    expect(countTrackState({ done: 200, total: 200, dueISO: '2026-10-01', todayISO: today })).toBe('done');
  });
  it('is done when the record says Completed, idle with nothing to count', () => {
    expect(countTrackState({ done: 2, total: 9, dueISO: '2026-10-01', todayISO: today, complete: true })).toBe('done');
    expect(countTrackState({ done: 0, total: 0, dueISO: '2026-10-01', todayISO: today })).toBe('idle');
  });
});

describe('Portfolios and Projects at Risk bars', () => {
  it('draws 199 of 200 past due in red, a Completed project green, an empty one gray', () => {
    const a = render(<PortfolioBar stats={{ completed: 199, total: 200, pct: 100 }} project={{ dueOn: '2020-01-01', status: 'in_progress' }} />);
    expect(track(a).className).toContain('is-overdue');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('100% complete');
    a.unmount();
    const b = render(<PortfolioBar stats={{ completed: 1, total: 4, pct: 25 }} project={{ dueOn: '2020-01-01', status: 'completed' }} />);
    expect(track(b).className).toContain('is-done');
    b.unmount();
    const c = render(<PortfolioBar stats={{ completed: 0, total: 0, pct: 0 }} project={{ dueOn: '2020-01-01' }} />);
    expect(track(c).className).toContain('is-idle');
  });

  it('Projects at Risk reads the counts too', () => {
    const rows = [{ p: { id: 'p1', name: 'Austin', dueOn: '2020-01-01' }, overdue: 1, dueWeek: 0, total: 200, done: 199 }];
    const c = render(<ProjectsAtRiskWidget rows={rows} onOpenProject={() => {}} onViewAll={() => {}} />);
    expect(track(c).className).toContain('is-overdue');
  });

  it('keeps name, progress and actions on a phone, everything on a computer', () => {
    const cols = [{ key: 'name' }, { key: 'tasks' }, { key: 'progress' }, { key: 'projects' }, { key: 'actions' }];
    expect(phoneColumns(cols, 'wide', false)).toEqual({ cols, template: 'wide' });
    const phone = phoneColumns(cols, 'wide', true);
    expect(phone.cols.map((c) => c.key)).toEqual(['name', 'progress', 'actions']);
    expect(phone.template).toBe('minmax(0,1fr) 96px 76px');
  });
});

describe('Performance goals', () => {
  const today = '2026-11-02';
  it('follows the server status first, so the bar and the label agree (review 6)', () => {
    expect(goalTrackState({ value: 40, status: 'done', today })).toBe('done');
    expect(goalTrackState({ value: 40, status: 'behind', dueOn: '2026-12-31', today })).toBe('overdue');
    expect(goalTrackState({ value: 40, status: 'off_track', today })).toBe('overdue');
    // The server says On Track / At Risk: orange, whatever the browser's date or the 100%.
    expect(goalTrackState({ value: 40, status: 'on_track', dueOn: '2026-10-31', today })).toBe('live');
    expect(goalTrackState({ value: 100, status: 'on_track', today })).toBe('live');
    expect(goalTrackState({ value: 40, status: 'at_risk', today })).toBe('live');
  });
  it('falls back to the counts, the overdue flag and the due date with no status', () => {
    expect(goalTrackState({ value: 100, today })).toBe('done');
    expect(goalTrackState({ value: 40, overdue: true, today })).toBe('overdue');
    expect(goalTrackState({ value: 40, dueOn: '2026-10-31', today })).toBe('overdue');
    expect(goalTrackState({ value: 40, dueOn: '2026-12-31', today })).toBe('live');
  });

  it('draws a Behind goal red even before its due date', () => {
    const c = render(<GoalBar value={40} status="behind" dueOn="2099-01-01" />);
    expect(track(c).className).toContain('is-overdue');
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

  it('names the phases that are behind, in order, once each (review 5)', () => {
    const items = [
      { phase: 'Before Day One', overdue: true, status: 'open' },
      { phase: 'Before Day One', overdue: true, status: 'open' },
      { phase: 'Day One', overdue: false, status: 'open' },
      { phase: 'Week One', overdue: true, status: 'open' },
      { phase: 'Week Two', overdue: true, status: 'done' },     // closed steps are not behind
    ];
    expect(behindPhases(items)).toEqual(['Before Day One', 'Week One']);
    expect(behindPhases([])).toEqual([]);
  });

  it('shows a warning in the house warning look, not orange (review 4)', () => {
    const { container } = render(<WarnNote>Unassigned</WarnNote>);
    const note = container.querySelector('.nx-warn-note');
    expect(note).not.toBeNull();
    expect(note.querySelector('svg')).not.toBeNull();     // the icon
    expect(screen.getByText('Unassigned')).toBeTruthy();
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
