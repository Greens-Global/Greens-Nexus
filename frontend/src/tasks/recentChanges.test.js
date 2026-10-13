import { describe, it, expect, beforeEach } from 'vitest';
import { RECENT_MS, markChanged, changedRecently, noteStatusChanges, _resetRecentChanges } from './recentChanges';

beforeEach(() => _resetRecentChanges());

describe('recentChanges', () => {
  it('marks a task whose status changed, and only that one', () => {
    const prev = [{ id: 1, status: 'todo' }, { id: 2, status: 'todo' }];
    const next = [{ id: 1, status: 'done' }, prev[1]];
    noteStatusChanges(prev, next, 1000);
    expect(changedRecently(1, 1000)).toBe(true);
    expect(changedRecently(2, 1000)).toBe(false);
  });

  it('marks a completion change even when the status stays', () => {
    noteStatusChanges([{ id: 1, status: 'todo', completed: false }], [{ id: 1, status: 'todo', completed: true }], 0);
    expect(changedRecently(1, 0)).toBe(true);
  });

  it('ignores loads, creates and edits that leave status alone', () => {
    noteStatusChanges([], [{ id: 1, status: 'todo' }], 0);
    noteStatusChanges([{ id: 1, status: 'todo', title: 'a' }], [{ id: 1, status: 'todo', title: 'b' }, { id: 2, status: 'done' }], 0);
    expect(changedRecently(1, 0)).toBe(false);
    expect(changedRecently(2, 0)).toBe(false);
  });

  it('expires after RECENT_MS', () => {
    markChanged(7, 0);
    expect(changedRecently(7, RECENT_MS)).toBe(true);
    expect(changedRecently(7, RECENT_MS + 1)).toBe(false);
    expect(changedRecently(7, 0)).toBe(false);   // swept, not just hidden
  });
});
