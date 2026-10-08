// The decision logic of the Links drag engine (useTileDrag.js), kept free
// of DOM and React so it can be unit-tested with an injected clock (Oct 8).
//
// Two questions are answered here, from where the CARRIED ICON's center sits:
//   1. Which slot is it over, and is it on that slot's icon body or in the
//      lane beside it?  (findSlot / inIconBody)
//   2. Given that, and how long it has been there, is this a fold, a shuffle,
//      or nothing yet?  (stepIntent / tickIntent / foldOnRelease)
//
// The iOS rules these implement:
//   - NOTHING happens instantly. A fold arms after resting on an icon body
//     for the dwell; a shuffle happens after lingering in the lane beside a
//     neighbor. A target can therefore never slide away from a direct
//     approach, which is what made folding so hard before (Sep 22-Oct 7:
//     the mouse shuffled the moment the carried icon crossed a same-row
//     target's center, so aiming at an icon pushed it aside first).
//   - An icon's BODY is its icon rect inflated a little (a finger needs
//     more than a mouse) plus the label under it: resting on the edge of the
//     icon or on its name is still "on the icon".
//   - Letting go while resting on an icon body folds even if the opening
//     animation has not finished (foldReleaseMs), for mouse and touch alike.
//   - A shuffle lane of at least MIN_SHUFFLE_LANE px always survives between
//     two neighboring icon bodies, so reordering by dragging into the gap
//     stays possible however tight the grid is.

export const MOUSE_TIMING = Object.freeze({
  foldDwellMs: 250,     // resting on an icon body this long arms the fold (was 280)
  foldReleaseMs: 120,   // rested at least this long at release -> fold even if not armed (was: mouse never)
  shuffleLingerMs: 160, // lingering in the lane beside a neighbor this long shuffles it (was 110, or instant past center)
  bodyPad: 10,          // px the icon rect is inflated by to make its body (was a 54px box, smaller than the 60px icon)
});
export const TOUCH_TIMING = Object.freeze({
  foldDwellMs: 200,     // unchanged
  foldReleaseMs: 120,   // was 90
  shuffleLingerMs: 300, // unchanged
  bodyPad: 16,          // was a 66px box
});
export const MIN_SHUFFLE_LANE = 16;

export function timingFor(touch) { return touch ? TOUCH_TIMING : MOUSE_TIMING; }

// A slot is { x, y, w, h, icon: { x, y, w, h } } with the icon rect relative
// to the slot's own top-left; px/py are in the same space as x/y.
export function slotHit(slot, px, py, padX, padY) {
  return px >= slot.x - padX && px <= slot.x + slot.w + padX && py >= slot.y - padY && py <= slot.y + slot.h + padY;
}

// The first slot whose box (inflated by half a gap, so the gaps belong to
// the tiles on either side) contains the point, or -1.
export function findSlot(slots, px, py, gapX, gapY) {
  for (let i = 0; i < slots.length; i++) {
    if (slotHit(slots[i], px, py, gapX / 2, gapY / 2)) return i;
  }
  return -1;
}

// The icon's body: the icon rect inflated by `pad` on the left, right and
// top, running down to the bottom of the tile so the label counts too. The
// side inflation is clamped so a lane of MIN_SHUFFLE_LANE stays free
// between this body and the neighbor's.
export function iconBody(slot, pad, gapX) {
  const ic = slot.icon || { x: slot.w / 2 - 30, y: 6, w: 60, h: 60 };
  const roomBetweenIcons = (slot.w - ic.w) + gapX; // icon edge to the next icon's edge
  const sidePad = Math.max(0, Math.min(pad, (roomBetweenIcons - MIN_SHUFFLE_LANE) / 2));
  return {
    x1: slot.x + ic.x - sidePad,
    x2: slot.x + ic.x + ic.w + sidePad,
    y1: slot.y + ic.y - pad,
    y2: slot.y + slot.h,
  };
}

export function inIconBody(slot, px, py, pad, gapX) {
  const b = iconBody(slot, pad, gapX);
  return px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2;
}

// The gesture's intent, carried from one pointer move to the next.
export function initialIntent() {
  return { foldCandidate: null, foldSince: 0, foldKey: null, pendingShuffle: null };
}

const result = (intent, extra = {}) => ({ intent, reorder: null, armed: false, cleared: false, ...extra });

// Expire the timers only: a shuffle whose linger has run out fires, a fold
// whose dwell has run out arms. Called every frame, and again from
// stepIntent so a pointer that keeps moving a hair still arms.
export function tickIntent(intent, now, timing) {
  let next = intent;
  let reorder = null, armed = false;
  if (next.pendingShuffle && now - next.pendingShuffle.since >= timing.shuffleLingerMs) {
    reorder = next.pendingShuffle.target;
    next = { ...next, pendingShuffle: null };
  }
  if (next.foldCandidate && !next.foldKey && now - next.foldSince >= timing.foldDwellMs) {
    next = { ...next, foldKey: next.foldCandidate };
    armed = true;
  }
  return result(next, { reorder, armed });
}

// One pointer move. hit = { over, hole, targetKey, inBody, canFold, canReorder }:
// the slot index under the carried icon (-1 for none), the dragged tile's
// own slot, the key of the tile in `over`, whether the icon is on that
// tile's body, and what the grid allows between these two kinds of tile.
export function stepIntent(prev, hit, now, timing) {
  const { over, hole, targetKey, inBody, canFold, canReorder } = hit;
  const cleared = !!prev.foldKey;
  if (over < 0 || over === hole) {
    return result({ ...prev, foldCandidate: null, foldKey: null, pendingShuffle: null }, { cleared });
  }
  if (inBody && canFold) {
    if (prev.foldCandidate !== targetKey) {
      // A new target: the dwell starts now; any previous arming is gone.
      return result({ foldCandidate: targetKey, foldSince: now, foldKey: null, pendingShuffle: null }, { cleared });
    }
    return tickIntent({ ...prev, pendingShuffle: null }, now, timing);
  }
  // In the lane beside a tile (or on a tile this one can't fold with).
  let next = { ...prev, foldCandidate: null, foldKey: null };
  if (!canReorder) return result({ ...next, pendingShuffle: null }, { cleared });
  if (next.pendingShuffle?.target !== over) next = { ...next, pendingShuffle: { target: over, since: now } };
  const t = tickIntent(next, now, timing);
  return { ...t, cleared: cleared || t.cleared };
}

// What a release means: the armed target, or the body the icon has been
// resting on for at least foldReleaseMs - the person let go on it on
// purpose; the ring not having appeared yet is our latency, not theirs.
export function foldOnRelease(intent, now, timing) {
  if (intent.foldKey) return intent.foldKey;
  if (intent.foldCandidate && now - intent.foldSince >= timing.foldReleaseMs) return intent.foldCandidate;
  return null;
}
