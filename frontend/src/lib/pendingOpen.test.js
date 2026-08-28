// The half of the notification handoff that the window event cannot cover: the
// module owning the drawer is lazy(), so on a first visit the bell's event has
// already fired by the time the view mounts a listener. Without this note the
// click lands on My Tasks / the ticket list - the exact miss the event was
// added to fix, hidden by the fact that you are usually already in the module.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setPendingOpen, takePendingOpen, __clearPendingOpen } from './pendingOpen';

beforeEach(() => __clearPendingOpen());
afterEach(() => vi.useRealTimers());

describe('pendingOpen', () => {
  it('hands the id to a view that mounts after the request', () => {
    setPendingOpen('ticket', 'tk-1');
    expect(takePendingOpen('ticket')).toBe('tk-1');
  });

  it('is consumed once, so a later remount does not reopen a closed drawer', () => {
    setPendingOpen('task', 't-1');
    expect(takePendingOpen('task')).toBe('t-1');
    expect(takePendingOpen('task')).toBeNull();
  });

  it('keeps the two modules apart', () => {
    setPendingOpen('task', 't-1');
    setPendingOpen('ticket', 'tk-1');
    expect(takePendingOpen('ticket')).toBe('tk-1');
    expect(takePendingOpen('task')).toBe('t-1');
  });

  it('returns null when nothing was requested', () => {
    expect(takePendingOpen('task')).toBeNull();
  });

  it('ignores an empty request rather than storing a blank', () => {
    setPendingOpen('task', '');
    setPendingOpen('', 't-1');
    expect(takePendingOpen('task')).toBeNull();
  });

  it('drops a stale note - a request from minutes ago is not what anyone is asking for', () => {
    vi.useFakeTimers();
    setPendingOpen('ticket', 'tk-old');
    vi.advanceTimersByTime(31_000);
    expect(takePendingOpen('ticket')).toBeNull();
  });

  it('keeps the newest request when one arrives before the last was taken', () => {
    setPendingOpen('ticket', 'tk-1');
    setPendingOpen('ticket', 'tk-2');
    expect(takePendingOpen('ticket')).toBe('tk-2');
  });
});
