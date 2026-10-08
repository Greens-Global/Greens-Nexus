import { describe, it, expect } from 'vitest';
import {
  MOUSE_TIMING, TOUCH_TIMING, MIN_SHUFFLE_LANE,
  findSlot, iconBody, inIconBody, initialIntent, stepIntent, tickIntent, foldOnRelease, timingFor,
} from './tileDragLogic';

// The grid as the engine measures it: 86px tiles, 60px icons starting 6px
// down and centered, 14px between tiles on a row, 20px between rows.
const TILE = { w: 86, h: 110 };
const ICON = { x: 13, y: 6, w: 60, h: 60 };
const GAP_X = 14, GAP_Y = 20;
const row = (n, y = 0) => Array.from({ length: n }, (_, i) => ({ x: i * (TILE.w + GAP_X), y, ...TILE, icon: ICON }));
const iconCenter = (slot) => ({ px: slot.x + ICON.x + ICON.w / 2, py: slot.y + ICON.y + ICON.h / 2 });

// A drag of the tile in slot `hole` whose carried icon sits at (px, py).
function hitAt(slots, hole, px, py, { touch = false, folderCount = 0, kind = 'item' } = {}) {
  const timing = timingFor(touch);
  const over = findSlot(slots, px, py, GAP_X, GAP_Y);
  const hit = { over, hole, targetKey: null, inBody: false, canFold: false, canReorder: false };
  if (over >= 0 && over !== hole) {
    hit.targetKey = `k${over}`;
    hit.inBody = inIconBody(slots[over], px, py, timing.bodyPad, GAP_X);
    hit.canReorder = kind === 'folder' ? over < folderCount : over >= folderCount;
    hit.canFold = kind === 'item';
  }
  return hit;
}

describe('icon body hit test', () => {
  const slots = row(3);

  it('counts the icon itself, its inflated edge and the label below as the body', () => {
    const s = slots[1];
    const { px, py } = iconCenter(s);
    expect(inIconBody(s, px, py, MOUSE_TIMING.bodyPad, GAP_X)).toBe(true);
    // 8px outside the icon's right edge: still the body (pad is 10).
    expect(inIconBody(s, s.x + ICON.x + ICON.w + 8, py, MOUSE_TIMING.bodyPad, GAP_X)).toBe(true);
    // On the label, under the icon.
    expect(inIconBody(s, px, s.y + TILE.h - 8, MOUSE_TIMING.bodyPad, GAP_X)).toBe(true);
    // Above the icon, past the pad: not the body.
    expect(inIconBody(s, px, s.y + ICON.y - MOUSE_TIMING.bodyPad - 1, MOUSE_TIMING.bodyPad, GAP_X)).toBe(false);
  });

  it('is at least as big as the old 54px box used to be, in every direction', () => {
    const s = slots[1];
    const b = iconBody(s, MOUSE_TIMING.bodyPad, GAP_X);
    expect(b.x2 - b.x1).toBeGreaterThan(54);
    expect(b.y2 - b.y1).toBeGreaterThan(54);
    expect(b.x2 - b.x1).toBeGreaterThanOrEqual(ICON.w); // the whole icon counts
  });

  it('always leaves a shuffle lane between two neighboring bodies', () => {
    for (const pad of [MOUSE_TIMING.bodyPad, TOUCH_TIMING.bodyPad, 40]) {
      const a = iconBody(slots[0], pad, GAP_X), b = iconBody(slots[1], pad, GAP_X);
      expect(b.x1 - a.x2).toBeGreaterThanOrEqual(MIN_SHUFFLE_LANE - 0.001);
    }
  });

  it('a touch body is bigger than a mouse body where there is room', () => {
    const wide = { x: 0, y: 0, w: 120, h: 120, icon: { x: 30, y: 6, w: 60, h: 60 } };
    const m = iconBody(wide, MOUSE_TIMING.bodyPad, GAP_X), t = iconBody(wide, TOUCH_TIMING.bodyPad, GAP_X);
    expect(t.x2 - t.x1).toBeGreaterThan(m.x2 - m.x1);
    expect(t.y1).toBeLessThan(m.y1);
  });

  it('findSlot gives the gaps to the tiles on either side and nothing to the void', () => {
    expect(findSlot(slots, slots[1].x + 43, 50, GAP_X, GAP_Y)).toBe(1);
    expect(findSlot(slots, slots[0].x + TILE.w + 3, 50, GAP_X, GAP_Y)).toBe(0);  // left half of the gap
    expect(findSlot(slots, slots[1].x - 3, 50, GAP_X, GAP_Y)).toBe(1);           // right half of the gap
    expect(findSlot(slots, slots[2].x + TILE.w + 60, 50, GAP_X, GAP_Y)).toBe(-1);
    expect(findSlot(slots, 40, -40, GAP_X, GAP_Y)).toBe(-1);
  });
});

describe('fold vs shuffle (mouse)', () => {
  const T = MOUSE_TIMING;
  const slots = row(4);

  it('resting on an icon body never shuffles and arms the fold after the dwell', () => {
    const { px, py } = iconCenter(slots[0]);
    let r = stepIntent(initialIntent(), hitAt(slots, 2, px, py), 1000, T);
    expect(r.reorder).toBeNull();
    expect(r.armed).toBe(false);
    expect(r.intent.foldCandidate).toBe('k0');
    r = tickIntent(r.intent, 1000 + T.foldDwellMs - 1, T);
    expect(r.armed).toBe(false);
    expect(r.intent.foldKey).toBeNull();
    r = tickIntent(r.intent, 1000 + T.foldDwellMs, T);
    expect(r.armed).toBe(true);
    expect(r.intent.foldKey).toBe('k0');
    expect(foldOnRelease(r.intent, 1000 + T.foldDwellMs + 1, T)).toBe('k0');
  });

  it('a jittery hand arms through stepIntent too, not only the frame loop', () => {
    const { px, py } = iconCenter(slots[0]);
    let r = stepIntent(initialIntent(), hitAt(slots, 2, px, py), 0, T);
    r = stepIntent(r.intent, hitAt(slots, 2, px + 2, py + 1), 120, T);
    expect(r.armed).toBe(false);
    r = stepIntent(r.intent, hitAt(slots, 2, px - 1, py + 2), T.foldDwellMs, T);
    expect(r.armed).toBe(true);
    expect(r.intent.foldKey).toBe('k0');
  });

  it('releasing on an icon body after a short rest folds even before the ring', () => {
    const { px, py } = iconCenter(slots[0]);
    const r = stepIntent(initialIntent(), hitAt(slots, 2, px, py), 0, T);
    expect(foldOnRelease(r.intent, T.foldReleaseMs - 1, T)).toBeNull();
    expect(foldOnRelease(r.intent, T.foldReleaseMs, T)).toBe('k0');
  });

  it('crossing an icon from the far side does not push it away (the old past-center rule is gone)', () => {
    // Tile in slot 3 heads left across slot 1: through its right lane, its
    // body, out its left lane - each step a few ms apart, no resting.
    const s = slots[1];
    const path = [s.x + TILE.w + 5, s.x + ICON.x + ICON.w + 5, s.x + ICON.x + 30, s.x + ICON.x - 2, s.x - 4];
    let intent = initialIntent();
    let now = 0;
    for (const px of path) {
      const r = stepIntent(intent, hitAt(slots, 3, px, 36), now, T);
      expect(r.reorder).toBeNull();
      intent = r.intent;
      now += 30;
    }
    expect(intent.foldKey).toBeNull();
  });

  it('lingering in the lane beside a neighbor shuffles it after the linger, not before', () => {
    const s = slots[1];
    const laneX = s.x - 3; // the gap between slot 0 and slot 1, slot 1's half
    let r = stepIntent(initialIntent(), hitAt(slots, 3, laneX, 36), 0, T);
    expect(r.reorder).toBeNull();
    expect(r.intent.pendingShuffle).toEqual({ target: 1, since: 0 });
    r = tickIntent(r.intent, T.shuffleLingerMs - 1, T);
    expect(r.reorder).toBeNull();
    r = tickIntent(r.intent, T.shuffleLingerMs, T);
    expect(r.reorder).toBe(1);
    expect(r.intent.pendingShuffle).toBeNull();
  });

  it('a quick sweep through several lanes shuffles nothing', () => {
    let intent = initialIntent();
    let now = 0;
    const xs = [slots[2].x - 3, slots[1].x + TILE.w + 3, slots[1].x - 3, slots[0].x + TILE.w + 3, slots[0].x + 40];
    for (const px of xs) {
      const r = stepIntent(intent, hitAt(slots, 3, px, 36), now, T);
      expect(r.reorder).toBeNull();
      intent = r.intent;
      now += 40;
    }
  });

  it('moving to a different lane restarts the linger', () => {
    let r = stepIntent(initialIntent(), hitAt(slots, 3, slots[1].x - 3, 36), 0, T);
    r = stepIntent(r.intent, hitAt(slots, 3, slots[0].x + TILE.w + 3, 36), 100, T); // now slot 0's half
    expect(r.intent.pendingShuffle).toEqual({ target: 0, since: 100 });
    r = tickIntent(r.intent, 100 + T.shuffleLingerMs - 1, T);
    expect(r.reorder).toBeNull();
  });

  it('leaving the body clears an armed fold and tells the UI so', () => {
    const { px, py } = iconCenter(slots[0]);
    let r = stepIntent(initialIntent(), hitAt(slots, 2, px, py), 0, T);
    r = tickIntent(r.intent, T.foldDwellMs, T);
    expect(r.intent.foldKey).toBe('k0');
    r = stepIntent(r.intent, hitAt(slots, 2, slots[3].x + TILE.w + 80, py), T.foldDwellMs + 10, T);
    expect(r.cleared).toBe(true);
    expect(r.intent.foldKey).toBeNull();
    expect(foldOnRelease(r.intent, T.foldDwellMs + 20, T)).toBeNull();
  });

  it('over its own hole or over nothing, nothing is pending', () => {
    const { px, py } = iconCenter(slots[2]);
    let r = stepIntent(initialIntent(), hitAt(slots, 2, px, py), 0, T);
    expect(r.intent).toEqual(initialIntent());
    r = stepIntent(initialIntent(), hitAt(slots, 2, -500, -500), 0, T);
    expect(r.intent).toEqual(initialIntent());
  });

  it('an app over a folder tile folds into it, and never reorders with it', () => {
    const { px, py } = iconCenter(slots[0]);
    const hit = hitAt(slots, 2, px, py, { folderCount: 1 });
    expect(hit.canReorder).toBe(false);
    let r = stepIntent(initialIntent(), hit, 0, T);
    r = tickIntent(r.intent, T.foldDwellMs, T);
    expect(r.intent.foldKey).toBe('k0');
    // In the folder's lane an app has nothing to do: no shuffle pending.
    const lane = stepIntent(initialIntent(), hitAt(slots, 2, slots[0].x + TILE.w + 3, 36, { folderCount: 1 }), 0, T);
    expect(lane.intent.pendingShuffle).toBeNull();
  });

  it('a folder dragged over an app neither folds nor shuffles it', () => {
    const { px, py } = iconCenter(slots[2]);
    const hit = hitAt(slots, 0, px, py, { folderCount: 1, kind: 'folder' });
    expect(hit.canFold).toBe(false);
    expect(hit.canReorder).toBe(false);
    const r = stepIntent(initialIntent(), hit, 0, T);
    expect(r.intent.foldCandidate).toBeNull();
    expect(r.intent.pendingShuffle).toBeNull();
  });
});

describe('fold vs shuffle (touch)', () => {
  const T = TOUCH_TIMING;
  const slots = row(4);

  it('uses the slower linger and the shorter dwell', () => {
    expect(T.shuffleLingerMs).toBeGreaterThan(MOUSE_TIMING.shuffleLingerMs);
    expect(T.foldDwellMs).toBeLessThanOrEqual(MOUSE_TIMING.foldDwellMs);
    const { px, py } = iconCenter(slots[0]);
    let r = stepIntent(initialIntent(), hitAt(slots, 2, px, py, { touch: true }), 0, T);
    r = tickIntent(r.intent, T.foldDwellMs, T);
    expect(r.armed).toBe(true);
    let l = stepIntent(initialIntent(), hitAt(slots, 3, slots[1].x - 3, 36, { touch: true }), 0, T);
    l = tickIntent(l.intent, MOUSE_TIMING.shuffleLingerMs, T);
    expect(l.reorder).toBeNull();
    l = tickIntent(l.intent, T.shuffleLingerMs, T);
    expect(l.reorder).toBe(1);
  });

  it('a finger let go on an icon after a short rest folds', () => {
    const { px, py } = iconCenter(slots[0]);
    const r = stepIntent(initialIntent(), hitAt(slots, 2, px, py, { touch: true }), 0, T);
    expect(foldOnRelease(r.intent, T.foldReleaseMs, T)).toBe('k0');
    expect(foldOnRelease(r.intent, 30, T)).toBeNull();
  });
});
