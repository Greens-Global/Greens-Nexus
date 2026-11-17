import { describe, it, expect, vi } from 'vitest';

const tickets = vi.hoisted(() => ({ get: () => Promise.resolve([]) }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => () => (k === 'getTaskTickets' ? tickets.get()
      : Promise.resolve(k === 'getTasksDelta' ? { tasks: [], serverTime: 's' } : [])),
  }),
}));

import { withRecent, withOlder, loadTaskData } from './taskStore';

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

// A collection whose fetch failed is handed over with ok = false (11/17/2026):
// the Tickets desk showed "No Tickets Yet" for a list that could not be read.
describe('a collection that could not be read', () => {
  const load = async () => {
    const seen = {};
    await loadTaskData((key, value, ok) => { seen[key] = { value, ok }; });
    return seen;
  };

  it('says so, keeping what was held, and reads as loaded again once it answers', async () => {
    tickets.get = () => Promise.reject(new Error('offline'));
    let seen = await load();
    expect(seen.tickets).toEqual({ value: [], ok: false });
    expect(seen.projects.ok).toBe(true);
    expect(seen.tasks.ok).toBe(true);

    tickets.get = () => Promise.resolve([{ id: 't1' }]);
    seen = await load();
    expect(seen.tickets).toEqual({ value: [{ id: 't1' }], ok: true });

    // A later failure keeps the list that was held, and still says it failed.
    tickets.get = () => Promise.reject(new Error('offline'));
    seen = await load();
    expect(seen.tickets).toEqual({ value: [{ id: 't1' }], ok: false });
  });
});
