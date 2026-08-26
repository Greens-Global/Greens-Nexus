import { describe, it, expect } from 'vitest';
import { taskAssignees, matchesFilter, groupTasks, EMPTY_FILTER } from './lib';

// A task can be assigned to several people, and there is one row with one
// `completed` flag - so whoever finishes it finishes it for all of them. These
// pin the reading rules that make that work, and in particular the two that are
// easy to get backwards: FILTERING matches any assignee, while GROUPING keys on
// the primary so a shared task appears exactly once.

const task = (over = {}) => ({ id: 't1', title: 'Fix the boiler', type: 'task', ...over });

describe('taskAssignees', () => {
  it('reads the list when there is one', () => {
    expect(taskAssignees(task({ assigneeIds: ['a@x.com', 'b@x.com'], assigneeId: 'a@x.com' })))
      .toEqual(['a@x.com', 'b@x.com']);
  });

  it('falls back to the primary mirror for a row written before the list existed', () => {
    expect(taskAssignees(task({ assigneeId: 'a@x.com' }))).toEqual(['a@x.com']);
    expect(taskAssignees(task({ assigneeIds: [], assigneeId: 'a@x.com' }))).toEqual(['a@x.com']);
  });

  it('is empty for an unassigned task', () => {
    expect(taskAssignees(task())).toEqual([]);
    expect(taskAssignees(task({ assigneeIds: [], assigneeId: null }))).toEqual([]);
  });

  it('survives a dirty list rather than throwing', () => {
    // Same guard the backend's email_list applies - these lists are user- and
    // import-supplied, and one bad entry must not take out a whole render.
    expect(taskAssignees(task({ assigneeIds: ['a@x.com', null, 5, '', 'b@x.com'] })))
      .toEqual(['a@x.com', 'b@x.com']);
  });

  it('does not throw on a missing task', () => {
    expect(taskAssignees(undefined)).toEqual([]);
    expect(taskAssignees(null)).toEqual([]);
  });
});

describe('filtering by assignee matches ANY of them', () => {
  const shared = task({ assigneeIds: ['ana@x.com', 'ben@x.com'], assigneeId: 'ana@x.com' });

  it('finds a task through its second assignee', () => {
    // The one that matters: Ben is not the primary, but the task is his work
    // and has to show up in his My Tasks.
    expect(matchesFilter(shared, { ...EMPTY_FILTER, assigneeIds: ['ben@x.com'] })).toBe(true);
  });

  it('finds it through the primary too', () => {
    expect(matchesFilter(shared, { ...EMPTY_FILTER, assigneeIds: ['ana@x.com'] })).toBe(true);
  });

  it('excludes somebody who is not on it', () => {
    expect(matchesFilter(shared, { ...EMPTY_FILTER, assigneeIds: ['cara@x.com'] })).toBe(false);
  });

  it('still works for a legacy single-assignee task', () => {
    const legacy = task({ assigneeId: 'ana@x.com' });
    expect(matchesFilter(legacy, { ...EMPTY_FILTER, assigneeIds: ['ana@x.com'] })).toBe(true);
    expect(matchesFilter(legacy, { ...EMPTY_FILTER, assigneeIds: ['ben@x.com'] })).toBe(false);
  });
});

describe('grouping by assignee lists a shared task under each person', () => {
  const ctx = { nameOf: (e) => ({ 'ana@x.com': 'Ana', 'ben@x.com': 'Ben' }[e] || e) };

  it('puts a shared task in both peoples groups', () => {
    // Keying on the primary left the second person's group looking empty while
    // the card itself showed their avatar - reported on the board's Assignee
    // swimlanes, Aug 2026.
    const groups = groupTasks(
      [task({ id: 's', assigneeIds: ['ana@x.com', 'ben@x.com'], assigneeId: 'ana@x.com' })],
      'assignee', ctx,
    );
    const byLabel = Object.fromEntries(groups.filter((g) => g.tasks.length).map((g) => [g.label, g.tasks]));
    expect(Object.keys(byLabel).sort()).toEqual(['Ana', 'Ben']);
    expect(byLabel.Ana).toHaveLength(1);
    expect(byLabel.Ben).toHaveLength(1);
    expect(byLabel.Ana[0].id).toBe(byLabel.Ben[0].id);   // one task, shown twice
  });

  it('counts the shared task for each person, so groups total more than the list', () => {
    // Deliberate: the same reading the Workload view uses. A task two people
    // share is real work on both their plates.
    const groups = groupTasks([
      task({ id: 's', assigneeIds: ['ana@x.com', 'ben@x.com'] }),
      task({ id: 'a', assigneeIds: ['ana@x.com'] }),
    ], 'assignee', ctx);
    const total = groups.reduce((n, g) => n + g.tasks.length, 0);
    expect(total).toBe(3);   // 2 tasks, 3 person-slots
  });

  it('still gives a single-assignee task exactly one group', () => {
    const groups = groupTasks([task({ id: 'o', assigneeId: 'ana@x.com' })], 'assignee', ctx);
    const withTask = groups.filter((g) => g.tasks.length);
    expect(withTask).toHaveLength(1);
    expect(withTask[0].label).toBe('Ana');
  });

  it('groups an unassigned task under Unassigned', () => {
    const groups = groupTasks([task({ id: 'u' })], 'assignee', ctx);
    const withTask = groups.filter((g) => g.tasks.length);
    expect(withTask[0].label).toBe('Unassigned');
  });
});
