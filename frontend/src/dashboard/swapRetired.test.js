// Action Required ('my-day') is retired (Neil, 11/13/2026). A saved board
// that carried it keeps loading: My Work stands in for it where the board
// had no My Work, and the retired tile is hidden everywhere.
import { describe, it, expect } from 'vitest';
import { swapRetired } from './useDashboards';
import { WIDGETS, widgetHidden } from './widgets.jsx';

const tile = (i, type, extra = {}) => ({ i, type, x: 0, y: 0, w: 4, h: 5, ...extra });

describe('swapRetired', () => {
  it('puts My Work where Action Required was, same place and size', () => {
    const out = swapRetired([tile('a', 'calendar'), tile('b', 'my-day', { x: 6, y: 2, w: 6, h: 8 })]);
    expect(out).toEqual([tile('a', 'calendar'), { i: 'b', type: 'my-work', x: 6, y: 2, w: 6, h: 8, config: undefined }]);
  });

  it('leaves a board that already has My Work with one - the retired tile stays, hidden', () => {
    const board = [tile('a', 'my-work'), tile('b', 'my-day')];
    const out = swapRetired(board);
    expect(out.map((w) => w.type)).toEqual(['my-work', 'my-day']);
    expect(widgetHidden(WIDGETS['my-day'], { timeTrackingExempt: false })).toBe(true);
    expect(widgetHidden(WIDGETS['my-work'], { timeTrackingExempt: false })).toBe(false);
  });

  it('two Action Required tiles become one My Work', () => {
    expect(swapRetired([tile('a', 'my-day'), tile('b', 'my-day')]).map((w) => w.type)).toEqual(['my-work', 'my-day']);
  });

  it('touches nothing else, and survives a bad layout', () => {
    const board = [tile('a', 'calendar'), tile('b', 'notifications')];
    expect(swapRetired(board)).toEqual(board);
    expect(swapRetired(null)).toEqual([]);
  });
});
