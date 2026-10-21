import { describe, it, expect } from 'vitest';
import { interviewerGroups, leadsFor } from './HiringSchedule';

// Neil, Oct 19: the interviewer picker puts the role's department first, its
// lead at the top.
describe('interviewerGroups', () => {
  const people = [
    { email: 'amy@x.com', name: 'Amy', department: 'Accounting' },
    { email: 'bob@x.com', name: 'Bob', department: 'IT' },
    { email: 'lee@x.com', name: 'Lee', department: 'accounting' },
    { email: 'cfo@x.com', name: 'Cara', department: 'Executive' },
  ];

  it('the department team first with its lead on top, then everyone else', () => {
    const [team, rest] = interviewerGroups(people, 'Accounting', ['cfo@x.com']);
    expect(team.label).toBe('Accounting Team');
    expect(team.people.map(p => p.email)).toEqual(['cfo@x.com', 'amy@x.com', 'lee@x.com']);
    expect(rest.people.map(p => p.email)).toEqual(['bob@x.com']);
  });

  it('no department: one list', () => {
    expect(interviewerGroups(people, '')).toEqual([{ label: 'Nexus People', people }]);
  });

  it('finds the leads however the department is capitalized', () => {
    expect(leadsFor({ Accounting: ['cfo@x.com'] }, ' accounting ')).toEqual(['cfo@x.com']);
    expect(leadsFor({}, 'IT')).toEqual([]);
  });
});
