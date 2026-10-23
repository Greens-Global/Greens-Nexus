// The Board's columns and swimlanes (Planner's board, Oct 22 2026).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  boardPrefs, boardSetup, boardHasSections, columnOptions, dueColumns, dueColumnOf, dueBoardColumns, dueColumnForTask, effectiveLanes, laneOptions,
  labelLaneTags, assigneeLanePeople, laneAddDefaults, isCoverCandidate,
} from './boardLayout';
import { calendarDatePatch } from './calendarMove';
import { todayISO } from './lib';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ; });
const at = (...parts) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(...parts)); };
const keys = (cols) => cols.map((c) => c.key);

describe('Due Date columns', () => {
  it('buckets by the local day, on either side of local midnight', () => {
    // Pacific time: 11:30 PM on Thu Oct 22 is already Oct 23 in UTC.
    process.env.TZ = 'America/Los_Angeles';
    at(2026, 9, 22, 23, 30);
    let today = todayISO();
    expect(today).toBe('2026-10-22');
    expect(dueColumnOf('2026-10-22', today)).toBe('today');
    expect(dueColumnOf('2026-10-23', today)).toBe('tomorrow');
    expect(dueColumnOf('2026-10-21', today)).toBe('overdue');
    at(2026, 9, 23, 0, 30);
    today = todayISO();
    expect(today).toBe('2026-10-23');
    expect(dueColumnOf('2026-10-22', today)).toBe('overdue');
    expect(dueColumnOf('2026-10-23', today)).toBe('today');
    // India, early morning: the UTC day is still the day before.
    process.env.TZ = 'Asia/Kolkata';
    at(2026, 9, 23, 2, 0);
    expect(todayISO()).toBe('2026-10-23');
    expect(dueColumnOf('2026-10-23', todayISO())).toBe('today');
  });

  it('weeks run Sunday to Saturday, and each bucket says where a drop lands', () => {
    const cols = dueColumns('2026-10-20');           // a Tuesday
    expect(keys(cols)).toEqual(['overdue', 'today', 'tomorrow', 'week', 'nextweek', 'later', 'none']);
    const by = Object.fromEntries(cols.map((c) => [c.key, c]));
    expect(by.week).toMatchObject({ from: '2026-10-22', to: '2026-10-24', first: '2026-10-22' });
    expect(by.nextweek).toMatchObject({ from: '2026-10-25', to: '2026-10-31', first: '2026-10-25' });
    expect(by.later.first).toBe('2026-11-01');
    expect(by.overdue.first).toBeNull();
    expect(by.none.first).toBe('');
    expect(dueColumnOf('2026-10-24', '2026-10-20')).toBe('week');
    expect(dueColumnOf('2026-10-25', '2026-10-20')).toBe('nextweek');
    expect(dueColumnOf('2026-11-01', '2026-10-20')).toBe('later');
    expect(dueColumnOf('', '2026-10-20')).toBe('none');
    expect(dueColumnOf('2026-10-21T15:00', '2026-10-20')).toBe('tomorrow');   // a time does not move the day
  });

  it('a completed task is in Completed, never Overdue, whatever its date', () => {
    expect(keys(dueBoardColumns('2026-10-20')).at(-1)).toBe('completed');
    expect(dueColumnForTask({ dueOn: '2026-10-01', completed: true }, '2026-10-20')).toBe('completed');
    expect(dueColumnForTask({ dueOn: '2026-10-21', completed: true }, '2026-10-20')).toBe('completed');
    expect(dueColumnForTask({ dueOn: '2026-10-01' }, '2026-10-20')).toBe('overdue');
  });

  it('a Friday or Saturday has no This Week left; next week starts after tomorrow', () => {
    expect(keys(dueColumns('2026-10-23'))).not.toContain('week');            // Friday
    const sat = Object.fromEntries(dueColumns('2026-10-24').map((c) => [c.key, c]));
    expect(sat.week).toBeUndefined();
    expect(sat.tomorrow.first).toBe('2026-10-25');                              // Sunday
    expect(sat.nextweek).toMatchObject({ from: '2026-10-26', first: '2026-10-26', to: '2026-10-31' });
    expect(dueColumnOf('2026-10-25', '2026-10-24')).toBe('tomorrow');
    expect(dueColumnOf('2026-10-27', '2026-10-24')).toBe('nextweek');
  });

  it('crosses month and year ends', () => {
    const by = Object.fromEntries(dueColumns('2026-12-30').map((c) => [c.key, c]));   // a Wednesday
    expect(by.tomorrow.first).toBe('2026-12-31');
    expect(by.week).toMatchObject({ from: '2027-01-01', to: '2027-01-02' });
    expect(by.nextweek).toMatchObject({ from: '2027-01-03', to: '2027-01-09' });
  });
});

describe('calendarDatePatch (the Calendar day move, used by Due Date columns)', () => {
  it('moves a dated task like the Calendar, dates an undated one, and clears', () => {
    expect(calendarDatePatch({ startOn: '2026-10-20', dueOn: '2026-10-22' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24', startOn: '2026-10-22' });
    expect(calendarDatePatch({ dueOn: '' }, '2026-10-24')).toEqual({ dueOn: '2026-10-24' });
    expect(calendarDatePatch({ dueOn: '2026-10-22' }, '')).toEqual({ dueOn: '' });
    expect(calendarDatePatch({ dueOn: '' }, '')).toBeNull();
    expect(calendarDatePatch({ dueOn: '2026-10-22' }, '2026-10-22')).toBeNull();
  });
});

describe('Group on Board = the swimlanes', () => {
  const fields = [
    { id: 'f1', name: 'Stage', type: 'select', options: [{ id: 'a', label: 'A' }] },
    { id: 'f2', name: 'Notes', type: 'text' },
    { id: 'f3', name: 'Empty', type: 'select', options: [] },
  ];
  it('offers lanes that make sense, never the columns\' own dimension', () => {
    expect(keys(laneOptions({ columns: 'status', lockedProjectId: '', fields })))
      .toEqual(['none', 'assignee', 'priority', 'project', 'label', 'cf:f1']);
    expect(keys(laneOptions({ columns: 'priority', lockedProjectId: 'p1', fields })))
      .toEqual(['none', 'assignee', 'label', 'cf:f1']);
  });

  it('a value the board does not offer is None, and is not written back', () => {
    const opts = laneOptions({ columns: 'status', lockedProjectId: 'p1' });
    expect(effectiveLanes('status', opts)).toBe('none');          // the List's default grouping
    expect(effectiveLanes('section', opts)).toBe('none');
    expect(effectiveLanes('project', opts)).toBe('none');         // locked to one project
    expect(effectiveLanes('cf:gone', opts)).toBe('none');
    expect(effectiveLanes('assignee', opts)).toBe('assignee');
    expect(boardSetup({ lanes: 'priority', columns: 'priority' })).toMatchObject({ lanes: 'none', columns: 'priority' });
    expect(boardSetup({ lanes: 'label', columns: 'section', hasSections: false })).toMatchObject({ lanes: 'label', columns: 'status' });
  });

  it('Section columns only on a project with its own Custom sections', () => {
    expect(keys(columnOptions())).toEqual(['status', 'priority', 'due']);
    expect(keys(columnOptions({ hasSections: true }))).toEqual(['status', 'section', 'priority', 'due']);
    expect(boardHasSections('p1', { sections: [{ id: 's' }], personal: false })).toBe(true);
    expect(boardHasSections('', { sections: [{ id: 's' }], personal: false })).toBe(false);
    expect(boardHasSections('p1', { sections: [{ id: 's' }], personal: true })).toBe(false);
    expect(boardHasSections('p1', { sections: [], personal: false })).toBe(false);
  });

  it('remembers mine first, then a default Board, then my general choice', () => {
    expect(boardPrefs({ lanes: 'label' }, { view: 'board', group: 'assignee', columns: 'due' }, { lanes: 'priority', columns: 'priority', previews: false }))
      .toEqual({ lanes: 'label', columns: 'due', previews: false });
    // A default Board's own lanes; one saved before lanes existed opens with
    // none - its `group` is the List's grouping, not lanes anybody chose.
    expect(boardPrefs(null, { view: 'board', group: 'status', lanes: 'label' }, null).lanes).toBe('label');
    expect(boardPrefs(null, { view: 'board', group: 'assignee' }, null).lanes).toBe('none');
    // A default List says nothing about the board.
    expect(boardPrefs(null, { view: 'list', group: 'status' }, { lanes: 'priority' })).toEqual({ lanes: 'priority', columns: 'status', previews: true });
    expect(boardPrefs(null, null, null)).toEqual({ lanes: 'none', columns: 'status', previews: true });
  });
});

describe('lane drops', () => {
  it('label A to label B swaps only those two', () => {
    expect(labelLaneTags(['A', 'X'], 'A', 'B')).toEqual(['X', 'B']);
    expect(labelLaneTags(['A', 'B'], 'A', 'B')).toEqual(['B']);              // already had B
    expect(labelLaneTags([], '__none', 'B')).toEqual(['B']);                  // from No Label
    expect(labelLaneTags(['A', 'X'], 'A', '__none')).toEqual(['X']);          // onto No Label: only A goes
    expect(labelLaneTags(['A'], 'A', 'A')).toBeNull();                        // same lane
  });

  it('assignee lanes hand the card over from the lane it came from', () => {
    expect(assigneeLanePeople(['a', 'b'], 'a', 'c')).toEqual(['c', 'b']);
    expect(assigneeLanePeople(['a', 'b'], 'a', '__none')).toEqual(['b']);
    expect(assigneeLanePeople([], '__none', 'c')).toEqual(['c']);
    expect(assigneeLanePeople(['a', 'c'], 'a', 'c')).toEqual(['c']);
    expect(assigneeLanePeople(['a'], 'a', 'a')).toBeNull();
  });

  it('a card added in a lane takes the lane', () => {
    expect(laneAddDefaults('label', 'Urgent')).toEqual({ tags: ['Urgent'] });
    expect(laneAddDefaults('assignee', 'a@x.com')).toEqual({ assigneeIds: ['a@x.com'] });
    expect(laneAddDefaults('cf:f1', 'a')).toEqual({ customFieldValues: { f1: 'a' } });
    expect(laneAddDefaults('label', '__none')).toEqual({});
  });
});

describe('cover candidates', () => {
  it('an image file in our storage; never an Egnyte link, a failed upload or an inline file', () => {
    expect(isCoverCandidate({ kind: 'image', name: 'a.png', url: 'https://x/files/view?u=1' })).toBe(true);
    expect(isCoverCandidate({ kind: 'other', name: 'site.JPG', url: 'https://x/y' })).toBe(true);
    expect(isCoverCandidate({ kind: 'egnyte', name: 'a.png', url: 'https://greens.egnyte.com/x' })).toBe(false);
    expect(isCoverCandidate({ kind: 'image', name: 'a.png', url: '' })).toBe(false);
    expect(isCoverCandidate({ kind: 'image', name: 'a.png', url: 'data:image/png;base64,AA' })).toBe(false);
    expect(isCoverCandidate({ kind: 'doc', name: 'spec.pdf', url: 'https://x/y' })).toBe(false);
  });
});
