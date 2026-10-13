import { describe, it, expect } from 'vitest';
import { orderSubtasks, reorderedPositions } from './lib';

// Subtask order (Oct 13 2026): soonest due date first, the higher priority
// first among the same date, undated last - until someone drags them.
const t = (id, dueOn, priority, position) => ({ id, dueOn, priority, position });

describe('orderSubtasks', () => {
  const subs = [t('a', '', 'urgent', 1), t('b', '2026-11-20', 'low', 2), t('c', '2026-11-20', 'high', 3), t('d', '2026-11-05', 'medium', 4)];

  it('by due date, then priority, undated last', () => {
    expect(orderSubtasks(subs, {}).map((s) => s.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('the same date and priority keep the order they were added in', () => {
    expect(orderSubtasks([t('y', '2026-11-05', 'high', 9), t('x', '2026-11-05', 'high', 3)], {}).map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('the dragged order once the main task is manual', () => {
    expect(orderSubtasks(subs, { subtaskOrder: 'manual' }).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('reorderedPositions', () => {
  const shown = [t('d', '', '', 40), t('c', '', '', 30), t('b', '', '', 20), t('a', '', '', 10)];

  it('numbers the new order 1, 2, 3...', () => {
    expect(reorderedPositions(shown, 'a', 0)).toEqual([
      { id: 'a', position: 1 }, { id: 'd', position: 2 }, { id: 'c', position: 3 }, { id: 'b', position: 4 },
    ]);
  });

  it('writes only what changes, and nothing for a move to the same place', () => {
    const numbered = [t('a', '', '', 1), t('b', '', '', 2), t('c', '', '', 3)];
    expect(reorderedPositions(numbered, 'c', 1)).toEqual([{ id: 'c', position: 2 }, { id: 'b', position: 3 }]);
    expect(reorderedPositions(numbered, 'b', 1)).toEqual([]);
  });
});
