import { describe, it, expect } from 'vitest';
import { findPeople } from './peopleSearch';

const P = [
  { name: 'Charmi Desai', email: 'charmi@x.com', title: 'HR Manager', site: 'Escondido' },
  { name: 'Sai Kumar', email: 'sai@x.com', title: 'Developer', site: 'Pune' },
  { name: 'Amy Wilson', email: 'amy@x.com', title: 'HR Coordinator', site: 'Austin' },
];

describe('findPeople', () => {
  it('ranks a first-name prefix over a mid-name hit', () => {
    expect(findPeople(P, 'sai').list.map((p) => p.name)).toEqual(['Sai Kumar', 'Charmi Desai']);
  });

  it('needs every word to match somewhere, context fields included', () => {
    const r = findPeople(P, 'hr aus', { fields: ['title', 'site'] });
    expect(r.list.map((p) => p.name)).toEqual(['Amy Wilson']);
    expect(r.words).toEqual(['hr', 'aus']);
  });

  it('ignores context fields it was not given', () => {
    expect(findPeople(P, 'austin').total).toBe(0);
  });

  it('caps the list but reports the full count', () => {
    const r = findPeople(P, 'a', { fields: ['title'], limit: 2 });
    expect(r.list).toHaveLength(2);
    expect(r.total).toBe(3);
  });
});
