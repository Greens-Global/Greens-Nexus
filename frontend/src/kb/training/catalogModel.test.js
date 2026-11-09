// The catalog's pure rules (11/07/2026): shelves by department, filters,
// stages on a path, the next item, the paths People still lacks.
import { describe, it, expect } from 'vitest';
import { filterCourses, shelveCourses, stagesOf, nextOnPath, pathsForMe, courseAction, suggestPaths, GENERAL, pathOrder, pathProgress, pathCountText, stageInHand, isStarted, blurb, titleWords, courseSteps } from './catalogModel';

const C = (over) => ({ id: over.id, title: over.title || over.id, description: '', code: '', tags: [], department_list: [], level: '', my_status: 'Not Started', assigned: false, my_pct: 0, ...over });
const courses = [
  C({ id: 'ops1', title: 'Cubby Fundamentals', department_list: ['Operations'], level: 'core', tags: ['cubby'], assigned: true, my_status: 'In Progress', my_pct: 40 }),
  C({ id: 'ops2', title: 'Self-Storage Fundamentals', department_list: ['Operations'], level: 'foundations', my_status: 'Completed' }),
  C({ id: 'acc1', title: 'Month-End Close', department_list: ['Accounting'], level: 'advanced' }),
  C({ id: 'gen1', title: 'Nexus Fundamentals', level: 'foundations', description: 'Every new hire takes it' }),
];

describe('shelveCourses', () => {
  it('puts your own department first, General last, completed last', () => {
    const shelves = shelveCourses(courses, 'Accounting');
    expect(shelves.map((s) => s.name)).toEqual(['Accounting', 'Operations', GENERAL]);
    expect(shelves[1].courses.map((c) => c.id)).toEqual(['ops1', 'ops2']);   // completed sinks under the started one
    expect(shelveCourses([C({ id: 'x', level: 'core' }), C({ id: 'y', level: 'foundations' })], '')[0].courses.map((c) => c.id)).toEqual(['y', 'x']);   // foundations before core
  });
  it('orders a shelf the way a path takes it, ahead of the level', () => {
    const order = pathOrder([{ stages: ['A', 'B'], items: [{ kind: 'course', id: 'ops2', stage: 1 }, { kind: 'course', id: 'ops1', stage: 0 }] }]);
    expect(shelveCourses(courses, 'Accounting', order)[1].courses.map((c) => c.id)).toEqual(['ops1', 'ops2']);
  });
  it('sinks Completed courses below open ones, each part in path order', () => {
    const shelf = [C({ id: 'a', my_status: 'Completed' }), C({ id: 'b' }), C({ id: 'c', my_status: 'Completed' }), C({ id: 'd', my_status: 'In Progress' })];
    const order = pathOrder([{ stages: ['A'], items: ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'course', id, stage: 0 })) }]);
    expect(shelveCourses(shelf, '', order)[0].courses.map((c) => c.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('progress: one resolver', () => {
  const path = { stages: ['Week 1', 'Week 2'], items: [
    { kind: 'course', id: 'nf', status: 'In Progress', pct: 13, done: false, stage: 0 },
    { kind: 'course', id: 'ss', status: 'Not Started', pct: 0, done: false, stage: 0 },
    { kind: 'course', id: 'cb', status: 'Not Started', pct: 0, done: false, stage: 1 },
    { kind: 'policy', id: 'p', status: 'To Sign', done: false, stage: 1 },
  ] };
  it('a path with a course under way says Continue, counts it in progress, and never reads 0%', () => {
    expect(pathProgress(path)).toMatchObject({ done: 0, total: 4, started: 1, pct: 3, action: 'Continue' });
    expect(pathCountText(path)).toBe('0 of 4 done · 1 in progress');
    expect(nextOnPath(path).id).toBe('nf');
    expect(stageInHand(path)).toBe(0);
  });
  it('an untouched path says Start; a finished one Review and no stage in hand', () => {
    expect(pathProgress({ items: [{ status: 'Not Started', pct: 0 }] }).action).toBe('Start');
    const all = { items: [{ done: true }, { done: true }] };
    expect(pathProgress(all)).toMatchObject({ finished: true, action: 'Review', pct: 100 });
    expect(stageInHand(all)).toBe(-1);
  });
  it('a course card and a path item agree on Start / Continue', () => {
    expect(courseAction({ my_status: 'Overdue', my_pct: 13 })).toBe('Continue');
    expect(courseAction({ my_status: 'Overdue', my_pct: 0 })).toBe('Start');
    expect(courseAction({ status: 'In Progress', pct: 13 })).toBe(courseAction({ my_status: 'In Progress', my_pct: 13 }));
    expect(isStarted({ my_status: 'Completed', my_pct: 100 })).toBe(false);
  });
});

describe('titleWords and courseSteps', () => {
  it('writes a tag in Title Case and keeps capitals', () => {
    expect(['new hire', 'RV storage', 'self-storage'].map(titleWords)).toEqual(['New Hire', 'RV Storage', 'Self-Storage']);
  });
  it('counts steps the way the server counts the percent: lessons plus the final', () => {
    expect(courseSteps({ lessons: [{ done: true }, { done: false }], quiz: { question_count: 40, passed: false } })).toEqual({ done: 1, total: 3 });
    expect(courseSteps({ lessons: [{ done: true }], quiz: { question_count: 0 } })).toEqual({ done: 1, total: 1 });
  });
});

describe('blurb', () => {
  it('cuts at a sentence, never mid-sentence', () => {
    const t = 'Every new hire takes it. Sign in, punch in and fix a missed punch, sign your Time Sheet, request time off and HR help, report problems with tickets and forms. And more.';
    expect(blurb(t, 60)).toBe('Every new hire takes it.');
    expect(blurb('Short.', 60)).toBe('Short.');
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
