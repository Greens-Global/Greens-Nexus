// A screen's own leave prompt (the schedule's Save / Keep Editing / Discard,
// Oct 28 2026): leaving asks it instead of the plain prompt, and only while set.
import { describe, it, expect } from 'vitest';
import { hasUnsavedWork, setLeaveGuard, askToLeave } from './dialogGuard';

describe('setLeaveGuard', () => {
  it('counts as unsaved work and answers the leave question while set', async () => {
    expect(hasUnsavedWork()).toBe(false);
    setLeaveGuard(() => Promise.resolve(true));
    expect(hasUnsavedWork()).toBe(true);
    await expect(askToLeave()).resolves.toBe(true);
    setLeaveGuard(() => Promise.resolve(false));
    await expect(askToLeave()).resolves.toBe(false);
    setLeaveGuard(null);
    expect(hasUnsavedWork()).toBe(false);
  });
});
