import { describe, it, expect } from 'vitest';
import { STATUS_META, STATUS_ORDER, isMissed } from './theme';
import { groupTasks } from './lib';

// Missed (Oct 2): a recurring occurrence the system closed when the next one
// came due before it was done. It has a chip wherever a status is drawn, but
// is never offered to pick - every status picker, board column and rule trigger
// is built from STATUS_ORDER, and Missed is not in it.

describe('the Missed status', () => {
  it('has a chip but is not a status anyone can pick', () => {
    expect(STATUS_META.missed.label).toBe('Missed');
    expect(STATUS_ORDER).not.toContain('missed');
  });

  it('is recognised on a task', () => {
    expect(isMissed({ status: 'missed' })).toBe(true);
    expect(isMissed({ status: 'completed' })).toBe(false);
    expect(isMissed(null)).toBe(false);
  });

  it('groups after every other status, not first', () => {
    const tasks = [
      { id: 'a', status: 'missed' }, { id: 'b', status: 'completed' },
      { id: 'c', status: 'not_started' }, { id: 'd', status: 'recurring' },
    ];
    const keys = groupTasks(tasks, 'status').map((g) => g.key);
    expect(keys[keys.length - 1]).toBe('missed');
    expect(keys.indexOf('completed')).toBeLessThan(keys.indexOf('missed'));
  });
});
