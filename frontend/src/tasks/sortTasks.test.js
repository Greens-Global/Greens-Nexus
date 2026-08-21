// Sorters behind the List view's clickable column headers. The Person /
// Project / Team columns show a NAME resolved from an id, so the interesting
// case is that they sort by that name and not by the id underneath it.
import { describe, it, expect } from 'vitest';
import { sortTasks, cfKey } from './lib';

const ctx = {
  nameOf: (e) => ({ 'z@x.com': 'Aarav Mehta', 'a@x.com': 'Zoe Wright' }[e] || e),
  projectName: (id) => ({ p2: 'Alpha', p1: 'Zulu' }[id] || id),
  teamName: (id) => ({ t2: 'Design', t1: 'Ops' }[id] || id),
};
const titles = (list) => list.map((t) => t.title);

describe('sortTasks - columns that had no sorter', () => {
  it('sorts Estimate numerically, not as text', () => {
    const list = [
      { title: 'b', estimateHours: 9 },
      { title: 'a', estimateHours: 10 },
      { title: 'c', estimateHours: 2 },
    ];
    expect(titles(sortTasks(list, { key: 'estimate', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
  });

  it('sorts Actual numerically', () => {
    const list = [{ title: 'a', actualHours: 3 }, { title: 'b', actualHours: 1 }];
    expect(titles(sortTasks(list, { key: 'actual', dir: 'asc' }))).toEqual(['b', 'a']);
  });

  it('sorts Timeline by start date, falling back to due', () => {
    const list = [
      { title: 'later', startOn: '2026-08-20' },
      { title: 'dueOnly', dueOn: '2026-08-01' },
      { title: 'early', startOn: '2026-08-05' },
    ];
    expect(titles(sortTasks(list, { key: 'timeline', dir: 'asc' }))).toEqual(['dueOnly', 'early', 'later']);
  });
});

describe('sortTasks - id columns sort by the name on screen', () => {
  it('sorts Person by display name, not email', () => {
    const list = [{ title: 'a', assigneeId: 'a@x.com' }, { title: 'z', assigneeId: 'z@x.com' }];
    // By email 'a@x.com' leads; by NAME Aarav Mehta (z@x.com) does.
    expect(titles(sortTasks(list, { key: 'assignee', dir: 'asc' }, [], ctx))).toEqual(['z', 'a']);
  });

  it('sorts Project by project name, not id', () => {
    const list = [{ title: 'a', projectId: 'p1' }, { title: 'b', projectId: 'p2' }];
    expect(titles(sortTasks(list, { key: 'project', dir: 'asc' }, [], ctx))).toEqual(['b', 'a']);
  });

  it('sorts Team by team name, not id', () => {
    const list = [{ title: 'a', teamId: 't1' }, { title: 'b', teamId: 't2' }];
    expect(titles(sortTasks(list, { key: 'team', dir: 'asc' }, [], ctx))).toEqual(['b', 'a']);
  });

  it('falls back to the raw id when no ctx is given', () => {
    const list = [{ title: 'a', assigneeId: 'a@x.com' }, { title: 'z', assigneeId: 'z@x.com' }];
    expect(titles(sortTasks(list, { key: 'assignee', dir: 'asc' }))).toEqual(['a', 'z']);
  });
});

describe('sortTasks - blanks and direction', () => {
  it('puts blank values last ascending', () => {
    const list = [{ title: 'blank' }, { title: 'has', estimateHours: 4 }];
    expect(titles(sortTasks(list, { key: 'estimate', dir: 'asc' }))).toEqual(['has', 'blank']);
  });

  it('reverses on desc', () => {
    const list = [
      { title: 'a', estimateHours: 1 },
      { title: 'b', estimateHours: 2 },
      { title: 'c', estimateHours: 3 },
    ];
    expect(titles(sortTasks(list, { key: 'estimate', dir: 'desc' }))).toEqual(['c', 'b', 'a']);
  });

  it('leaves the input array untouched', () => {
    const list = [{ title: 'b', estimateHours: 2 }, { title: 'a', estimateHours: 1 }];
    sortTasks(list, { key: 'estimate', dir: 'asc' });
    expect(titles(list)).toEqual(['b', 'a']);
  });
});

describe('sortTasks - custom field columns', () => {
  const selectField = {
    id: 'f_mod', name: 'Module', type: 'select',
    // Option ORDER is the sort order - not alphabetical.
    options: [{ id: 'o_design', label: 'Design' }, { id: 'o_build', label: 'Build' }],
  };
  const numberField = { id: 'f_pts', name: 'Points', type: 'number' };
  const textField = { id: 'f_loc', name: 'Location', type: 'text' };
  const checkboxField = { id: 'f_ok', name: 'Signed Off', type: 'checkbox' };
  const fields = [selectField, numberField, textField, checkboxField];

  const cf = (title, values) => ({ title, customFieldValues: values });

  it('sorts a select field by its option order, not alphabetically', () => {
    const list = [cf('build', { f_mod: 'o_build' }), cf('design', { f_mod: 'o_design' })];
    expect(titles(sortTasks(list, { key: cfKey('f_mod'), dir: 'asc' }, fields)))
      .toEqual(['design', 'build']);
  });

  it('sorts a number field numerically', () => {
    const list = [cf('nine', { f_pts: 9 }), cf('ten', { f_pts: 10 }), cf('two', { f_pts: 2 })];
    expect(titles(sortTasks(list, { key: cfKey('f_pts'), dir: 'asc' }, fields)))
      .toEqual(['two', 'nine', 'ten']);
  });

  it('sorts a text field alphabetically', () => {
    const list = [cf('z', { f_loc: 'Zurich' }), cf('a', { f_loc: 'Austin' })];
    expect(titles(sortTasks(list, { key: cfKey('f_loc'), dir: 'asc' }, fields)))
      .toEqual(['a', 'z']);
  });

  it('sorts a checkbox field with ticked first', () => {
    const list = [cf('off', { f_ok: false }), cf('on', { f_ok: true })];
    expect(titles(sortTasks(list, { key: cfKey('f_ok'), dir: 'asc' }, fields)))
      .toEqual(['on', 'off']);
  });

  it('puts tasks with no value for the field last', () => {
    const list = [cf('empty', {}), cf('has', { f_pts: 5 })];
    expect(titles(sortTasks(list, { key: cfKey('f_pts'), dir: 'asc' }, fields)))
      .toEqual(['has', 'empty']);
  });

  it('reverses a custom field sort on desc', () => {
    const list = [cf('design', { f_mod: 'o_design' }), cf('build', { f_mod: 'o_build' })];
    expect(titles(sortTasks(list, { key: cfKey('f_mod'), dir: 'desc' }, fields)))
      .toEqual(['build', 'design']);
  });

  it('falls back to manual order when the field is not in scope', () => {
    // A column hidden or scoped out of this project must not blow up the list.
    const list = [{ title: 'b', position: 2 }, { title: 'a', position: 1 }];
    expect(titles(sortTasks(list, { key: cfKey('f_gone'), dir: 'asc' }, fields)))
      .toEqual(['a', 'b']);
  });
});

describe('sortTasks - Collaborators column (My Tasks)', () => {
  it('sorts by the alphabetically first collaborator name, not by email', () => {
    const list = [
      // a@x.com is Zoe Wright, z@x.com is Aarav Mehta - so by EMAIL the first
      // task would lead, by NAME the second does.
      { title: 'zoe', followerIds: ['a@x.com'] },
      { title: 'aarav', followerIds: ['z@x.com'] },
    ];
    expect(titles(sortTasks(list, { key: 'collaborators', dir: 'asc' }, [], ctx)))
      .toEqual(['aarav', 'zoe']);
  });

  it('uses the earliest name when a task has several collaborators', () => {
    const list = [
      { title: 'zoeOnly', followerIds: ['a@x.com'] },                 // Zoe Wright
      { title: 'both', followerIds: ['a@x.com', 'z@x.com'] },         // Aarav + Zoe -> Aarav
    ];
    expect(titles(sortTasks(list, { key: 'collaborators', dir: 'asc' }, [], ctx)))
      .toEqual(['both', 'zoeOnly']);
  });

  it('puts tasks with no collaborators last', () => {
    const list = [{ title: 'none', followerIds: [] }, { title: 'some', followerIds: ['a@x.com'] }];
    expect(titles(sortTasks(list, { key: 'collaborators', dir: 'asc' }, [], ctx)))
      .toEqual(['some', 'none']);
  });
});
