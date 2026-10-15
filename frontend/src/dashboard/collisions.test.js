import { describe, it, expect } from 'vitest';
import { resolveCollisions, moveInOrder, readingOrder } from './useDashboards';

// Collisions (Oct 14): a drop, a resize, a config change or a clamp on load
// must never leave two tiles on top of each other - the board used to save
// whatever the drop left behind.

const overlaps = (items) => items.some(a => items.some(b => a.i !== b.i
  && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

const BOARD = [
  { i: 'a', x: 0, y: 0, w: 6, h: 2 },
  { i: 'b', x: 6, y: 0, w: 6, h: 2 },
  { i: 'c', x: 0, y: 2, w: 6, h: 3 },
  { i: 'd', x: 6, y: 2, w: 6, h: 3 },
];

describe('resolveCollisions', () => {
  it('returns a board with no overlaps unchanged (same object)', () => {
    expect(resolveCollisions(BOARD)).toBe(BOARD);
  });

  it('keeps the dropped tile where it was dropped and pushes what it covers down', () => {
    const dropped = BOARD.map(it => it.i === 'c' ? { ...it, x: 6, y: 0 } : it);   // c lands on b
    const out = resolveCollisions(dropped, ['c']);
    expect(overlaps(out)).toBe(false);
    expect(out.find(it => it.i === 'c')).toMatchObject({ x: 6, y: 0 });
    expect(out.find(it => it.i === 'b').y).toBe(3);     // just below c
    expect(out.find(it => it.i === 'a')).toEqual(BOARD[0]);   // untouched tiles never move
  });

  it('settles a tile that grew into the one below it (a clamp or a bigger style)', () => {
    const grown = BOARD.map(it => it.i === 'a' ? { ...it, h: 4 } : it);
    const out = resolveCollisions(grown, ['a']);
    expect(overlaps(out)).toBe(false);
    expect(out.find(it => it.i === 'c').y).toBe(4);
    expect(out.find(it => it.i === 'd').y).toBe(2);
  });

  it('untangles a saved board that already overlaps, in reading order', () => {
    const saved = [
      { i: 'x', x: 0, y: 0, w: 4, h: 4 },
      { i: 'y', x: 2, y: 1, w: 4, h: 2 },
    ];
    const out = resolveCollisions(saved);
    expect(overlaps(out)).toBe(false);
    expect(out.find(it => it.i === 'x')).toEqual(saved[0]);
    expect(out.find(it => it.i === 'y').y).toBe(4);
  });
});

describe('moveInOrder keeps the phone arrows to what is visible', () => {
  it('a move among the shown tiles never lands on a hidden one once settled', () => {
    const shown = [
      { i: 'a', x: 0, y: 0, w: 12, h: 2 },
      { i: 'b', x: 0, y: 2, w: 12, h: 2 },
    ];
    const hidden = [{ i: 'h', x: 0, y: 4, w: 12, h: 2 }];
    const moved = moveInOrder(shown, 'b', -1);
    expect(readingOrder(moved).map(it => it.i)).toEqual(['b', 'a']);
    const out = resolveCollisions([...moved, ...hidden], moved.map(it => it.i));
    expect(overlaps(out)).toBe(false);
  });
});
