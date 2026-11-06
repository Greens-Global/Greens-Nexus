import { describe, it, expect } from 'vitest';
import { withRecent, withOlder } from './taskStore';

const old = (id) => ({ id, completed: true, completedAt: '2020-01-02T00:00:00+00:00' });
const open = (id) => ({ id, completed: false, completedAt: null });

describe('two-part first load (11/05/2026)', () => {
  it('a fresh recent part keeps the long-done tasks already held', () => {
    const out = withRecent([old('o1'), open('gone')], [open('a')]);
    expect(out.map((t) => t.id)).toEqual(['a', 'o1']);   // 'gone' was not long-done: the recent part decides it
  });
  it('the older part adds what is missing and drops long-done rows it no longer lists', () => {
    const held = { ...old('o1'), title: 'edited since' };
    const out = withOlder([open('a'), held, old('deleted')], [old('o1'), old('o2')]);
    expect(out.map((t) => t.id)).toEqual(['a', 'o1', 'o2']);
    expect(out[1].title).toBe('edited since');            // the held copy wins
  });
});
