import { describe, it, expect } from 'vitest';
import { moveInOrder, readingOrder } from './useDashboards';

// Phone reordering (Sep 28): the phone shows the board as one column in
// reading order, and the up/down arrows must move a widget exactly one place
// in that order - without overlapping anything on the desktop grid.

const ids = (items) => readingOrder(items).map(it => it.i);
const overlaps = (items) => items.some(a => items.some(b => a.i !== b.i
  && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

const BOARD = [
  { i: 'a', x: 0, y: 0, w: 3, h: 2 },
  { i: 'b', x: 3, y: 0, w: 3, h: 2 },
  { i: 'c', x: 6, y: 0, w: 3, h: 2 },
  { i: 'd', x: 0, y: 2, w: 6, h: 5 },
  { i: 'e', x: 6, y: 2, w: 3, h: 5 },
  { i: 'f', x: 0, y: 7, w: 8, h: 5 },
];

describe('moveInOrder', () => {
  it('swaps same-size neighbors in place, leaving everything else alone', () => {
    const next = moveInOrder(BOARD, 'b', -1);
    expect(ids(next)).toEqual(['b', 'a', 'c', 'd', 'e', 'f']);
    expect(next.find(it => it.i === 'b')).toMatchObject({ x: 0, y: 0 });
    expect(next.find(it => it.i === 'a')).toMatchObject({ x: 3, y: 0 });
    for (const k of ['c', 'd', 'e', 'f']) expect(next.find(it => it.i === k)).toEqual(BOARD.find(it => it.i === k));
  });

  it('moves a different-size widget one place and never overlaps', () => {
    for (const [id, dir] of [['d', -1], ['c', 1], ['e', 1], ['f', -1], ['a', 1]]) {
      const before = ids(BOARD);
      const k = before.indexOf(id);
      const want = [...before];
      [want[k], want[k + dir]] = [want[k + dir], want[k]];
      const next = moveInOrder(BOARD, id, dir);
      expect(ids(next)).toEqual(want);
      expect(overlaps(next)).toBe(false);
      // Sizes are the user's - reordering never resizes.
      for (const it of next) expect([it.w, it.h]).toEqual([BOARD.find(b => b.i === it.i).w, BOARD.find(b => b.i === it.i).h]);
    }
  });

  it('keeps holding up under repeated moves (a widget walked to the top)', () => {
    let board = BOARD;
    for (let n = 0; n < 5; n++) board = moveInOrder(board, 'f', -1);
    expect(ids(board)[0]).toBe('f');
    expect(overlaps(board)).toBe(false);
  });

  it('is a no-op past either end', () => {
    expect(moveInOrder(BOARD, 'a', -1)).toBe(BOARD);
    expect(moveInOrder(BOARD, 'f', 1)).toBe(BOARD);
    expect(moveInOrder(BOARD, 'nope', 1)).toBe(BOARD);
  });
});
