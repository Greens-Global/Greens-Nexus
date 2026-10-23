// Tasks Home's rules (Oct 23 2026 Home pass). focusBucket must agree with the
// dashboard's backend rule (backend/test_dashboard_task_focus.py has the same
// cases), so the Home's "need you now" and the dashboard number never differ.
import { describe, it, expect } from 'vitest';
import {
  focusBucket, focusCounts, tileCounts, upcomingGroups, dueLabel, dayTitle, twoLetterDay,
  completedWeeks, versusLastWeek, projectsAtRisk, teamWorkload, addDays,
} from './homeRules';

const TODAY = '2026-10-23';   // a Friday
const t = (o) => ({ id: Math.random().toString(36).slice(2), title: 'T', type: 'task', status: 'not_started', completed: false, assigneeIds: ['me'], ...o });

describe('focusBucket - the dashboard rule', () => {
  const b = (o) => focusBucket(t(o), TODAY);
  it('one-offs count when overdue or due within 30 days', () => {
    expect(b({ dueOn: '2026-09-01' })).toBe('focus');
    expect(b({ dueOn: TODAY })).toBe('focus');
    expect(b({ dueOn: '2026-11-22' })).toBe('focus');
    expect(b({ dueOn: '2026-11-23' })).toBe('later');
    expect(b({ dueOn: '2026-11-22T17:00:00' })).toBe('focus');
  });
  it('no due date is named, not counted', () => {
    expect(b({ dueOn: '' })).toBe('undated');
    expect(b({ dueOn: null })).toBe('undated');
    expect(b({ dueOn: 'someday' })).toBe('undated');
  });
  it('in progress always counts', () => {
    expect(b({ status: 'in_progress', dueOn: '' })).toBe('focus');
    expect(b({ status: 'in_progress', dueOn: '2027-06-01', recurrence: { freq: 'weekly' } })).toBe('focus');
  });
  it('a repeating task counts once its date has come', () => {
    expect(b({ recurrence: { freq: 'weekly' }, dueOn: TODAY })).toBe('focus');
    expect(b({ recurrence: { freq: 'weekly' }, dueOn: '2026-10-24' })).toBe('recurring');
    expect(b({ recurrence: { freq: 'weekly' }, dueOn: '' })).toBe('recurring');
    expect(b({ status: 'recurring', dueOn: '2026-11-01' })).toBe('recurring');
    expect(b({ recurrence: {}, dueOn: '2026-11-01' })).toBe('focus');
    expect(b({ recurrence: 'weekly', dueOn: '2026-11-01' })).toBe('focus');   // malformed = no rule
  });
  it('counts only open tasks', () => {
    const c = focusCounts([t({ dueOn: TODAY }), t({ dueOn: TODAY, completed: true }), t({ dueOn: '' }), t({ status: 'recurring', dueOn: '2026-12-01' })], TODAY);
    expect(c).toEqual({ focus: 1, undated: 1, recurring: 1, later: 0 });
  });
});

describe('tileCounts', () => {
  it('overdue, due today, the next 7 days and in progress - open tasks only, no fractions', () => {
    const c = tileCounts([
      t({ dueOn: '2026-10-20' }), t({ dueOn: TODAY }), t({ dueOn: '2026-10-29' }), t({ dueOn: '2026-10-30' }),
      t({ status: 'in_progress' }), t({ dueOn: TODAY, completed: true }), t({ dueOn: '2026-10-20', status: 'missed' }),
    ], TODAY);
    expect(c).toEqual({ overdue: 1, today: 1, week: 2, inProgress: 1 });
  });
});

describe('upcomingGroups', () => {
  it('groups Today / Tomorrow / This Week / Later in the window, urgent first in a day, undated apart', () => {
    const rows = [
      t({ id: 'a', dueOn: TODAY, priority: 'low', title: 'b' }), t({ id: 'b', dueOn: TODAY, priority: 'urgent', title: 'a' }),
      t({ id: 'c', dueOn: '2026-10-24' }), t({ id: 'd', dueOn: '2026-10-28' }), t({ id: 'e', dueOn: '2026-11-10' }),
      t({ id: 'f', dueOn: '' }), t({ id: 'g', dueOn: '2026-10-20' }),
    ];
    const { groups, undated } = upcomingGroups(rows, TODAY, 30);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Today', ['b', 'a']], ['Tomorrow', ['c']], ['This Week', ['d']], ['Later', ['e']],
    ]);
    expect(undated.map((r) => r.id)).toEqual(['f']);
    expect(upcomingGroups(rows, TODAY, 0).groups.map((g) => g.label)).toEqual(['Today']);
  });
});

describe('dates people read', () => {
  it('says Today / Tomorrow / Yesterday / the weekday, else MM/DD/YYYY', () => {
    expect(dueLabel(TODAY, TODAY)).toBe('Today');
    expect(dueLabel('2026-10-24', TODAY)).toBe('Tomorrow');
    expect(dueLabel('2026-10-22', TODAY)).toBe('Yesterday');
    expect(dueLabel('2026-10-27', TODAY)).toBe('Tue');
    expect(dueLabel('2026-10-30', TODAY)).toBe('10/30/2026');
    expect(dueLabel('2026-10-01', TODAY)).toBe('10/01/2026');
  });
  it('never shows an ISO date in a tooltip', () => {
    expect(dayTitle('2026-10-23')).toBe('Fri, 10/23/2026');
    expect(twoLetterDay('2026-10-25')).toBe('Su');
  });
});

describe('completedWeeks', () => {
  it('this week by day, and last week to compare', () => {
    const at = (iso) => `${iso}T15:00:00`;
    const rows = [t({ completed: true, completedAt: at(TODAY) }), t({ completed: true, completedAt: at('2026-10-17') }),
      t({ completed: true, completedAt: at('2026-10-15') }), t({ completed: true, completedAt: at('2026-10-16') })];
    const w = completedWeeks(rows, TODAY);
    expect(w.days).toHaveLength(7);
    expect(w.days[6]).toEqual({ iso: TODAY, n: 1 });
    expect(w.total).toBe(2);
    expect(w.lastWeek).toBe(2);
    expect(versusLastWeek(2, 2)).toBe('Same as last week');
    expect(versusLastWeek(5, 2)).toBe('3 more than last week');
    expect(versusLastWeek(1, 2)).toBe('1 fewer than last week');
  });
});

describe('projectsAtRisk', () => {
  const projects = [
    { id: 'own', name: 'Owned', ownerId: 'me' }, { id: 'fol', name: 'Followed', followerIds: ['me'] },
    { id: 'none', name: 'Not Mine' }, { id: 'task', name: 'Have A Task' }, { id: 'arch', name: 'Archived', ownerId: 'me', archived: true },
    { id: 'calm', name: 'Calm', ownerId: 'me' },
  ];
  const tasks = [
    t({ projectId: 'own', dueOn: '2026-10-20', assigneeIds: ['x'] }), t({ projectId: 'own', dueOn: '2026-10-25', assigneeIds: ['x'] }),
    t({ projectId: 'own', completed: true, assigneeIds: ['x'] }),
    t({ projectId: 'fol', dueOn: '2026-10-26', assigneeIds: ['x'] }),
    t({ projectId: 'none', dueOn: '2026-10-01', assigneeIds: ['x'] }),
    t({ projectId: 'task', dueOn: '2026-10-01' }),
    t({ projectId: 'arch', dueOn: '2026-10-01' }),
    t({ projectId: 'calm', dueOn: '2027-01-01' }),
    t({ projectId: 'own', parentTaskId: 'p', dueOn: '2026-10-01', assigneeIds: ['x'] }),   // subtasks are not counted
  ];
  it('only my projects with overdue or due-this-week work, worst first', () => {
    const rows = projectsAtRisk(projects, tasks, { me: 'me', bookmarks: new Set(), today: TODAY });
    expect(rows.map((r) => [r.p.id, r.overdue, r.dueWeek, r.done, r.total])).toEqual([
      ['own', 1, 1, 1, 3], ['task', 1, 0, 0, 1], ['fol', 0, 1, 0, 1],
    ]);
  });
  it('a bookmark makes a project mine', () => {
    const rows = projectsAtRisk(projects, tasks, { me: 'me', bookmarks: new Set(['none']), today: TODAY });
    expect(rows.map((r) => r.p.id)).toContain('none');
  });
});

describe('teamWorkload', () => {
  it('counts each teammate\'s open, overdue and this week from the tasks the viewer can see', () => {
    const rows = teamWorkload(['a', 'b', 'c'], [
      t({ assigneeIds: ['a'], dueOn: '2026-10-01' }), t({ assigneeIds: ['a', 'b'], dueOn: addDays(TODAY, 3) }),
      t({ assigneeIds: ['b'] }), t({ assigneeIds: ['b'], completed: true }), t({ assigneeIds: ['z'] }),
    ], TODAY);
    expect(rows).toEqual([
      { email: 'a', open: 2, overdue: 1, week: 1 },
      { email: 'b', open: 2, overdue: 0, week: 1 },
      { email: 'c', open: 0, overdue: 0, week: 0 },
    ]);
  });
});
