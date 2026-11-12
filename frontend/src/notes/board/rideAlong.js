// Things ride along (Neil, 11/12/2026): a comment pin belongs to the item it
// was put on, and a vote's result line to the item it counts - move the item
// (by hand, by Sort, by Tidy Up, by its section) and they come with it.
// Before this a pin was fixed to a point of the board: sort the stickies and
// every comment was left pointing at nothing.
//
// Engine-free and stored on the elements themselves, so it saves, syncs and
// undoes like any shape: a pin's box carries `customData.nexusOn = { id, dx,
// dy }` - the item it sits on and where on it. A pin put on empty board
// carries none and stays a point, as before. Drag a pin onto another item
// and it belongs to that one; drag it off and it is free again.
//
// How the board tells who moved: `rideAlong(elements, prev)` compares each
// item and each rider with where they were the last time it looked (`prev`,
// kept by Board.jsx). The item moved and its rider did not -> the rider
// follows by the same amount. Both moved -> they were moved together,
// nothing to do. Only this browser's own changes are acted on (the person
// who moved the item moves its riders; everyone else receives both), so two
// people never chase each other's copies.
const live = (e) => !!e && !e.isDeleted;
const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const bump = (e, patch, now) => ({ ...e, ...patch, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now });
const CARRIERS = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'frame']);
const near = (a, b) => Math.abs(a - b) < 0.5;
const holds = (e, p) => p.x >= e.x && p.x <= e.x + (e.width || 0) && p.y >= e.y && p.y <= e.y + (e.height || 0);

export const isPin = (e) => live(e) && e.type === 'rectangle' && !!e.customData?.nexusComment;
const isVoteLine = (e) => live(e) && e.type === 'text' && !!e.customData?.nexusVoteLine;

/** What a pin dropped at `point` sits on: the last-drawn shape, sticky or
 *  picture under it, else the section it is in, else '' (empty board).
 *  Never another pin, and never anything in `skip`. */
export function carrierAt(elements, point, skip = null) {
  let item = '', section = '';
  for (const e of elements || []) {
    if (!live(e) || !CARRIERS.has(e.type) || e.customData?.nexusComment || skip?.has(e.id) || !holds(e, point)) continue;
    if (e.type === 'frame') section = e.id; else item = e.id;
  }
  return item || section;
}

/** A new pin's parts with the pin tied to `carrier` (an element), or as they are when there is none. */
export function tiePin(pin, carrier) {
  if (!carrier) return pin;
  const [box, ...rest] = pin;
  return [{ ...box, customData: { ...(box.customData || {}), nexusOn: { id: carrier.id, dx: box.x - carrier.x, dy: box.y - carrier.y } } }, ...rest];
}

/** Where everything that carries or rides is now: Map id -> [x, y]. */
export function positions(elements) {
  const out = new Map();
  for (const e of elements || []) if (live(e) && (CARRIERS.has(e.type) || isVoteLine(e))) out.set(e.id, [e.x, e.y]);
  return out;
}

/**
 * One look at the board after this person changed it. Returns { changed:
 * newer copies of what must move or be re-tied, next: the positions to keep
 * for the next look }. `dragging` = a drag is still under way: a pin being
 * dragged alone is not re-tied until it is dropped (its old position is kept
 * in `next` so the drop is still seen as a move).
 */
export function rideAlong(elements, prev, { dragging = false, now = Date.now() } = {}) {
  const byId = new Map();
  for (const e of elements || []) if (e?.id) byId.set(e.id, e);
  const next = positions(elements);
  const changed = new Map();
  const moved = (e) => { const p = prev?.get(e.id); return p ? (!near(p[0], e.x) || !near(p[1], e.y)) : false; };
  const delta = (e) => { const p = prev.get(e.id); return [e.x - p[0], e.y - p[1]]; };
  const shift = (e, dx, dy) => {
    const cur = changed.get(e.id) || e;
    const copy = bump(cur, { x: cur.x + dx, y: cur.y + dy }, now);
    changed.set(e.id, copy);
    next.set(e.id, [copy.x, copy.y]);
  };
  for (const e of elements || []) {
    if (isPin(e)) {
      const on = e.customData.nexusOn;
      const target = on?.id ? byId.get(on.id) : null;
      const known = !!prev?.has(e.id);
      const pinMoved = moved(e);
      if (target && live(target) && prev?.has(target.id) && moved(target) && !pinMoved && known) {
        const [dx, dy] = delta(target);
        shift(e, dx, dy);
        for (const t of elements) if (live(t) && t.containerId === e.id) shift(t, dx, dy);   // its words
      } else if (pinMoved && !(target && live(target) && moved(target))) {
        // The pin was moved by itself: it belongs to what it was dropped on.
        if (dragging) { next.set(e.id, prev.get(e.id)); continue; }
        const skip = new Set([e.id]);
        const cid = carrierAt(elements, { x: e.x, y: e.y }, skip);
        const c = cid ? byId.get(cid) : null;
        const want = c ? { id: c.id, dx: e.x - c.x, dy: e.y - c.y } : null;
        const same = (!want && !on) || (want && on && want.id === on.id && near(want.dx, on.dx) && near(want.dy, on.dy));
        if (!same) {
          const { nexusOn, ...rest } = e.customData;   // eslint-disable-line no-unused-vars
          changed.set(e.id, bump(e, { customData: want ? { ...rest, nexusOn: want } : rest }, now));
        }
      }
    } else if (isVoteLine(e)) {
      const target = byId.get(e.customData.nexusVoteLine);
      if (target && live(target) && prev?.has(target.id) && prev?.has(e.id) && moved(target) && !moved(e)) {
        const [dx, dy] = delta(target);
        shift(e, dx, dy);
      }
    }
  }
  return { changed: [...changed.values()], next };
}
