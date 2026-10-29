import { describe, it, expect } from 'vitest';
import { searchDocs } from './docsSearch';
import { withLocalExpiry } from './knownIssuesStore';

// Review fixes (Help Center, Oct 2026).
describe('Managers & Admins sections follow the reader', () => {
  it('leaves manager blocks out when allow says no to that kind', () => {
    const q = 'how access works';
    const all = searchDocs(q, { limit: 30, perDoc: 10, allow: () => true });
    expect(all.some((r) => r.kind === 'manager')).toBe(true);
    const staff = searchDocs(q, { limit: 30, perDoc: 10, allow: (id, kind) => kind !== 'manager' });
    expect(staff.some((r) => r.kind === 'manager')).toBe(false);
    // Everything else a staff member could read is still there.
    const rest = all.filter((r) => r.kind !== 'manager').map((r) => r.id);
    expect(staff.map((r) => r.id)).toEqual(rest.slice(0, staff.length));
  });
});

describe('Known Issues end at the reader’s own midnight', () => {
  it('flags an issue whose until day has passed here, keeps one that ends today', () => {
    const out = withLocalExpiry([
      { id: 'a', until: '2026-10-27' }, { id: 'b', until: '2026-10-28' }, { id: 'c', until: '' },
    ], '2026-10-28');
    expect(out.map((i) => !!i.expired)).toEqual([true, false, false]);
  });
});
