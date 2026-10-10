import { describe, it, expect } from 'vitest';
import { searchPeople, groupByDepartment, buildTree, chainUp, myTeam, vCardOf, csvOf, NO_DEPARTMENT } from './lib';

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

  it('my team is my manager, my peers and my reports', () => {
    expect(myTeam(sam, ALL).map((p) => p.email).sort()).toEqual(['bo@x', 'kim@x', 'lee@x']);
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
