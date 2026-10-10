import { describe, it, expect } from 'vitest';
import { searchPeople, groupByDepartment, buildTree, chainUp, myTeam, vCardOf, csvOf, presenceOf, splitTree, inheritedDivision, divisionNames, NO_DEPARTMENT } from './lib';

const P = (email, name, dept, mgr = '', role = '') => ({
  email, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1] || '', department: dept, managerEmail: mgr,
  departmentRole: role, jobTitle: 'Analyst', companyName: 'Co', location: 'Escondido Office',
});
const bo = P('bo@x', 'Bo Boss', 'Accounting', '', 'lead');
const sam = P('sam@x', 'Sam Staff', 'Accounting', 'bo@x');
const lee = P('lee@x', 'Lee Leave', 'IT', 'bo@x');
const kim = P('kim@x', 'Kim Kay', '', 'sam@x');
const ALL = [sam, lee, bo, kim];

describe('directory helpers', () => {
  it('matches every word anywhere and ranks name prefixes first', () => {
    expect(searchPeople(ALL, 'acc sam').map((p) => p.email)).toEqual(['sam@x']);
    expect(searchPeople(ALL, 'escondido').length).toBe(4);
    expect(searchPeople(ALL, 'b')[0].email).toBe('bo@x');       // "Bo" before "Bo"-less matches
    expect(searchPeople(ALL, '')).toBe(ALL);
  });

  it('groups by department, lead first, no-department last', () => {
    const g = groupByDepartment(ALL);
    expect(g.map((x) => x.name)).toEqual(['Accounting', 'IT', NO_DEPARTMENT]);
    expect(g[0].people.map((p) => p.email)).toEqual(['bo@x', 'sam@x']);
  });

  it('builds the reporting tree and survives a manager cycle', () => {
    const tree = buildTree(ALL);
    expect(tree.length).toBe(1);
    expect(tree[0].person.email).toBe('bo@x');
    expect(tree[0].children.map((n) => n.person.email)).toEqual(['lee@x', 'sam@x']);
    expect(tree[0].children[1].children[0].person.email).toBe('kim@x');
    const a = { ...P('a@x', 'A A', 'X', 'b@x') };
    const b = { ...P('b@x', 'B B', 'X', 'a@x') };
    const cyc = buildTree([a, b]);
    const walk = (n) => [n.person.email, ...n.children.flatMap(walk)];
    expect(cyc.flatMap(walk).sort()).toEqual(['a@x', 'b@x']);   // both placed, nobody twice, no hang
    expect(chainUp(kim, new Map(ALL.map((p) => [p.email, p]))).map((p) => p.email)).toEqual(['sam@x', 'bo@x']);
  });

  it('splits the chart into trees and the people not connected to one', () => {
    const solo = P('solo@x', 'Sol Solo', 'Ops');                       // no manager at all
    const outside = P('out@x', 'Ozzy Out', 'Ops', 'nobody@elsewhere');   // manager the viewer cannot see
    const { trees, loose } = splitTree(buildTree([...ALL, solo, outside]));
    expect(trees.map((t) => t.person.email)).toEqual(['bo@x']);
    expect(loose.map((p) => p.email).sort()).toEqual(['out@x', 'solo@x']);
  });

  it('inherits a division from the nearest tagged manager, as the People chart does', () => {
    const head = { ...bo, division: 'Finance' };
    const people = [head, sam, lee, kim];
    const byEmail = new Map(people.map((p) => [p.email, p]));
    expect(divisionNames(people)).toEqual(['Finance']);
    expect(inheritedDivision(kim, byEmail)).toBe('Finance');           // kim -> sam -> bo (Finance)
    expect(inheritedDivision(head, byEmail)).toBe('Finance');
    const stranger = P('zed@x', 'Zed Zee', 'IT');
    expect(inheritedDivision(stranger, new Map([...byEmail, [stranger.email, stranger]]))).toBe('');
    const a = P('a@x', 'A A', 'X', 'b@x'), b = P('b@x', 'B B', 'X', 'a@x');   // a cycle must not hang
    expect(inheritedDivision(a, new Map([[a.email, a], [b.email, b]]))).toBe('');
  });

  it('my team is my manager, my peers and my reports', () => {
    expect(myTeam(sam, ALL).map((p) => p.email).sort()).toEqual(['bo@x', 'kim@x', 'lee@x']);
  });

  it('maps Teams presence to a dot and a label', () => {
    expect(presenceOf({ availability: 'Available', activity: 'Available' })).toEqual({ color: '#16a34a', label: 'Available' });
    expect(presenceOf({ availability: 'Busy', activity: 'InACall' })).toEqual({ color: '#dc2626', label: 'In a Call' });
    expect(presenceOf({ availability: 'Away', activity: 'Away' }).label).toBe('Away');
    expect(presenceOf({ availability: 'PresenceUnknown' }).label).toBe('Offline');
    expect(presenceOf(null)).toBeNull();
  });

  it('exports a vCard and CSV with escaping', () => {
    const v = vCardOf({ ...bo, mobile: '(760) 555-0101', companyName: 'Greens, Inc' });
    expect(v).toContain('FN:Bo Boss');
    expect(v).toContain('ORG:Greens\\, Inc;Accounting');
    expect(v).toContain('TEL;TYPE=CELL,VOICE:(760) 555-0101');
    const csv = csvOf([{ ...sam, jobTitle: 'Analyst, Sr' }]);
    expect(csv.split('\r\n')[1]).toContain('"Analyst, Sr"');
  });
});
