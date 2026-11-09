// My Training opens with one To Do list (Neil, 11/02/2026): overdue first,
// then the soonest due date, policies to sign in the same list, nothing
// completed in it.
import { describe, it, expect } from 'vitest';
import { todoList, todoPct } from './MyTraining';

const data = {
  due: [
    { id: 'c-late', title: 'Forklift', my_status: 'In Progress', due_date: '2026-10-20', days_overdue: 13 },
    { id: 'c-soon', title: 'Gate Codes', my_status: 'Not Started', due_date: '2026-11-10', days_overdue: 0 },
    { id: 'c-nodate', title: 'Welcome', my_status: 'Not Started', due_date: '', days_overdue: 0 },
    { id: 'c-done', title: 'Old Course', my_status: 'Completed', due_date: '2026-10-01', days_overdue: 0 },
    { id: 'c-started', title: 'Alarms', my_status: 'In Progress', due_date: '2026-11-10', days_overdue: 0 },
  ],
  policies: [
    { id: 'p-late', title: 'Attendance Policy', signed: false, due: '2026-10-30', overdue_days: 3, version: '2.0' },
    { id: 'p-signed', title: 'Dress Code', signed: true, due: '', overdue_days: 0, version: '1.0' },
    { id: 'p-soon', title: 'Safety Policy', signed: false, due: '2026-11-05', overdue_days: 0, version: '1.0' },
  ],
  stats: { completed: 1 },
};

describe('todoList', () => {
  it('orders overdue first, then by due date, started before not started, no date last', () => {
    expect(todoList(data).map((t) => t.id)).toEqual(['c-late', 'p-late', 'p-soon', 'c-started', 'c-soon', 'c-nodate']);
  });
  it('leaves out what is done or signed', () => {
    const ids = todoList(data).map((t) => t.id);
    expect(ids).not.toContain('c-done');
    expect(ids).not.toContain('p-signed');
  });
  it('orders courses with the same due date the way their path takes them', () => {
    const d = { due: [
      { id: 'cubby', title: 'Cubby Fundamentals', my_status: 'Not Started', due_date: '2026-12-08', days_overdue: 0 },
      { id: 'nf', title: 'Nexus Fundamentals', my_status: 'In Progress', my_pct: 13, due_date: '2026-12-08', days_overdue: 0 },
      { id: 'ss', title: 'Self-Storage Fundamentals', my_status: 'Not Started', due_date: '2026-12-08', days_overdue: 0 },
    ], policies: [], plans: [{ stages: ['Week 1', 'Week 2'], items: [
      { kind: 'course', id: 'cubby', stage: 1 }, { kind: 'course', id: 'nf', stage: 0 }, { kind: 'course', id: 'ss', stage: 0 }] }] };
    expect(todoList(d).map((t) => t.id)).toEqual(['nf', 'ss', 'cubby']);
    expect(todoPct({ ...d, stats: { completed: 1 } }, todoList(d))).toBe(28);   // (1 done + 0.13) of 4, never 25% beside a course at 13%
  });
  it('is empty when nothing is owed', () => {
    expect(todoList({ due: [], policies: [], stats: { completed: 0 } })).toEqual([]);
  });
});
