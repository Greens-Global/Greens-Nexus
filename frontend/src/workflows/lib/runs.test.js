import { describe, it, expect } from 'vitest';
import { beforeFor, inRange, nextCursor, statusesFor, dayOf } from './runs';

// The Runs screen's paging and vocabulary (Oct 28 2026): the To date seeds
// the cursor, paging stops once a page is older than From, and the
// Actions view offers step statuses only.

const row = (iso) => ({ id: iso, startedAt: iso });

describe('workflows runs helpers', () => {
  it('seeds the cursor from the end of the To day, else none', () => {
    expect(beforeFor('2026-10-20')).toBe('2026-10-20T23:59:59.999Z');
    expect(beforeFor('')).toBeNull();
    expect(beforeFor(undefined)).toBeNull();
  });

  it('keeps the rows inside the range and leaves undated rows alone', () => {
    const rows = [row('2026-10-28T12:00:00Z'), row('2026-10-20T08:00:00Z'), row('2026-10-01T08:00:00Z'), { id: 'x', startedAt: '' }];
    expect(inRange(rows, '2026-10-10', '2026-10-25').map((r) => r.id)).toEqual(['2026-10-20T08:00:00Z', 'x']);
    expect(inRange(rows, '', '').length).toBe(4);
    expect(inRange(null, '2026-10-10', '')).toEqual([]);
  });

  it('stops paging once a page runs past the From date', () => {
    const page = [row('2026-10-28T12:00:00Z'), row('2026-10-05T08:00:00Z')];
    expect(nextCursor(page, '2026-10-05T08:00:00Z', '')).toBe('2026-10-05T08:00:00Z');
    expect(nextCursor(page, '2026-10-05T08:00:00Z', '2026-10-01')).toBe('2026-10-05T08:00:00Z');
    expect(nextCursor(page, '2026-10-05T08:00:00Z', '2026-10-10')).toBeNull();
    expect(nextCursor([], 'c', '2026-10-10')).toBe('c');
    expect(nextCursor(page, null, '')).toBeNull();
  });

  it('offers run statuses on Runs and only Done / Failed on Actions', () => {
    expect(statusesFor('runs')).toEqual(['running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled', 'test']);
    expect(statusesFor('actions')).toEqual(['done', 'failed']);
    expect(dayOf('2026-10-28T12:00:00Z')).toBe('2026-10-28');
    expect(dayOf('')).toBe('');
  });
});
