// The catalog's pure rules (11/07/2026): shelves by department, filters,
// stages on a path, the next item, the paths People still lacks.
import { describe, it, expect } from 'vitest';
import { filterCourses, shelveCourses, stagesOf, nextOnPath, pathsForMe, courseAction, suggestPaths, GENERAL } from './catalogModel';

const C = (over) => ({ id: over.id, title: over.title || over.id, description: '', code: '', tags: [], department_list: [], level: '', my_status: 'Not Started', assigned: false, my_pct: 0, ...over });
const courses = [
  C({ id: 'ops1', title: 'Cubby Fundamentals', department_list: ['Operations'], level: 'core', tags: ['cubby'], assigned: true, my_status: 'In Progress', my_pct: 40 }),
  C({ id: 'ops2', title: 'Self-Storage Fundamentals', department_list: ['Operations'], level: 'foundations', my_status: 'Completed' }),
  C({ id: 'acc1', title: 'Month-End Close', department_list: ['Accounting'], level: 'advanced' }),
  C({ id: 'gen1', title: 'Nexus Fundamentals', level: 'foundations', description: 'Every new hire takes it' }),
];

describe('shelveCourses', () => {
  it('puts your own department first, General last, foundations before core, completed last', () => {
    const shelves = shelveCourses(courses, 'Accounting');
    expect(shelves.map((s) => s.name)).toEqual(['Accounting', 'Operations', GENERAL]);
    expect(shelves[1].courses.map((c) => c.id)).toEqual(['ops1', 'ops2']);   // completed sinks under the started one
  });
});

describe('filterCourses', () => {
  it('matches a word in the title, tags or description', () => {
    expect(filterCourses(courses, { q: 'cubby' }).map((c) => c.id)).toEqual(['ops1']);
    expect(filterCourses(courses, { q: 'new hire' }).map((c) => c.id)).toEqual(['gen1']);
  });
  it('filters by department, level and state', () => {
    expect(filterCourses(courses, { department: 'Operations' }).length).toBe(2);
    expect(filterCourses(courses, { department: GENERAL }).map((c) => c.id)).toEqual(['gen1']);
    expect(filterCourses(courses, { level: 'advanced' }).map((c) => c.id)).toEqual(['acc1']);
    expect(filterCourses(courses, { show: 'todo' }).map((c) => c.id)).toEqual(['ops1']);
    expect(filterCourses(courses, { show: 'done' }).map((c) => c.id)).toEqual(['ops2']);
  });
});

describe('paths', () => {
  const path = { stages: ['Week 1', 'Week 2'], items: [
    { kind: 'course', id: 'a', title: 'A', done: true, stage: 0 }, { kind: 'course', id: 'b', title: 'B', done: false, stage: 1 },
    { kind: 'policy', id: 'p', title: 'P', done: false, stage: -1 }, { kind: 'course', id: 'c', title: 'C', done: false, stage: 9 },
  ] };
  it('groups items under their stage and the rest last', () => {
    const s = stagesOf(path);
    expect(s.map((x) => [x.name, x.items.map((i) => i.id)])).toEqual([['Week 1', ['a']], ['Week 2', ['b']], ['', ['p', 'c']]]);
  });
  it('a path with no stages is one list', () => {
    expect(stagesOf({ stages: [], items: path.items }).map((x) => x.items.length)).toEqual([4]);
  });
  it('names the next item not done, or null', () => {
    expect(nextOnPath(path).id).toBe('b');
    expect(nextOnPath({ items: [{ done: true }] })).toBeNull();
  });
  it('keeps the paths that are yours or for your role on top', () => {
    expect(pathsForMe([{ id: 1, enrolled: true }, { id: 2, for_me: true }, { id: 3 }]).map((p) => p.id)).toEqual([1, 2]);
  });
  it('the button says Start, Continue or Review', () => {
    expect([courseAction({ my_status: 'Not Started' }), courseAction({ my_status: 'In Progress' }), courseAction({ my_status: 'Completed' })]).toEqual(['Start', 'Continue', 'Review']);
  });
});

describe('suggestPaths', () => {
  it('suggests a role path and a department track for what People has and no active path covers', () => {
    const out = suggestPaths({ job_titles: ['Site Manager', 'Clerk'], departments: ['Operations', 'Accounting'] },
      [{ active: true, audience: { job_titles: ['site manager'] } }, { active: false, audience: { departments: ['Accounting'] } }]);
    expect(out.map((s) => `${s.kind}:${s.value}`)).toEqual(['role:Clerk', 'department:Operations', 'department:Accounting']);
    expect(out[0]).toMatchObject({ name: 'Clerk Path', audience: { job_titles: ['Clerk'] } });
  });
});
