// The ONE people tally (11/05/2026): the overview tiles and the directory's
// tabs read peopleTallies, so Total / Active / Current always add up.
import { describe, it, expect } from 'vitest';
import { peopleTallies } from './lib';

describe('peopleTallies', () => {
  it('names three different sets and makes them add up', () => {
    const employees = [
      ...Array.from({ length: 55 }, (_, i) => ({ id: `a${i}`, status: 'active' })),
      { id: 'o1', status: 'onboarding' },
      { id: 'n1', status: 'on_leave' },               // another live status: counted, not Active
      { id: 'l1', status: 'offboarded' },
      { id: 'i1', status: 'inactive' },
    ];
    const externals = [{ id: 'x1', identityType: 'external', status: 'active' }, { id: 'x2', identityType: 'guest', status: 'offboarded' }];
    const t = peopleTallies(employees, externals);
    expect(t).toEqual({ people: 57, active: 55, onboarding: 1, external: 1, current: 58, inactive: 3 });
    expect(t.current).toBe(t.people + t.external);    // the Current tab = Total + external
  });

  it('counts nothing for no one', () => {
    expect(peopleTallies()).toEqual({ people: 0, active: 0, onboarding: 0, external: 0, current: 0, inactive: 0 });
  });
});
