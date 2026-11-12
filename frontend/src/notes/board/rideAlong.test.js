// Things ride along (Neil, 11/12/2026): a comment pin and a vote line move
// with the item they sit on - the pure part.
import { describe, it, expect } from 'vitest';
import { carrierAt, tiePin, positions, rideAlong, isPin } from './rideAlong';
import { commentPin } from './markupTools';
import { sticky, sortStickies, stickyParts } from './stickies';
import { stampVotes } from './meet';
import { withThread, withReply, threadOf, pinParts, newThread } from './threads';

const NOW = 1_800_000_000_000;
const box = (id, x, y, w = 200, h = 100, extra = {}) => ({ id, type: 'rectangle', x, y, width: w, height: h, version: 1, ...extra });
const move = (els, id, dx, dy) => els.map((e) => (e.id === id ? { ...e, x: e.x + dx, y: e.y + dy, version: e.version + 1 } : e));
const apply = (els, changed) => { const m = new Map(changed.map((e) => [e.id, e])); return els.map((e) => m.get(e.id) || e); };
const who = { email: 'ana@x.com', name: 'Ana Ruiz' };

describe('ride along', () => {
  it('a pin belongs to the last-drawn item under it, else its section, else nothing - never another pin', () => {
    const els = [
      { id: 'sec', type: 'frame', x: 0, y: 0, width: 800, height: 600, version: 1 },
      box('under', 100, 100), box('over', 150, 120),
      ...commentPin({ x: 160, y: 130, text: 'x', number: 1, now: NOW }),
    ];
    expect(carrierAt(els, { x: 170, y: 140 })).toBe('over');
    expect(carrierAt(els, { x: 110, y: 110 })).toBe('under');
    expect(carrierAt(els, { x: 700, y: 500 })).toBe('sec');
    expect(carrierAt(els, { x: 2000, y: 0 })).toBe('');
    expect(carrierAt([...els, { ...box('gone', 2000, 0), isDeleted: true }], { x: 2010, y: 10 })).toBe('');
  });

  it('the item moves and its pin (words included) follows by the same amount; moved together, nothing happens', () => {
    const item = box('item', 100, 100);
    const pin = tiePin(commentPin({ x: 130, y: 120, text: 'Fix this', number: 1, now: NOW }), item);
    expect(pin[0].customData.nexusOn).toEqual({ id: 'item', dx: 30, dy: 20 });
    let els = [item, ...pin];
    let prev = positions(els);
    els = move(els, 'item', 400, -50);
    let r = rideAlong(els, prev, { now: NOW });
    expect(r.changed.map((e) => e.id).sort()).toEqual([pin[0].id, pin[1].id].sort());
    els = apply(els, r.changed);
    const [b, t] = [els.find((e) => e.id === pin[0].id), els.find((e) => e.id === pin[1].id)];
    expect([b.x, b.y]).toEqual([530, 70]);
    expect([t.x - pin[1].x, t.y - pin[1].y]).toEqual([400, -50]);
    expect(b.version).toBeGreaterThan(pin[0].version);                // a newer copy: it syncs and saves
    // the look after that changes nothing (it settles)
    prev = r.next;
    expect(rideAlong(els, prev, { now: NOW }).changed).toEqual([]);
    // dragged together (both selected): no second move
    const both = move(move(move(els, 'item', 10, 10), pin[0].id, 10, 10), pin[1].id, 10, 10);
    expect(rideAlong(both, prev, { now: NOW }).changed).toEqual([]);
  });

  it('a pin on empty board stays a point; dropped on an item it belongs to it, dragged off it is free again', () => {
    const item = box('item', 100, 100);
    const free = commentPin({ x: 900, y: 900, text: 'x', number: 1, now: NOW });
    expect(tiePin(free, null)).toBe(free);
    let els = [item, ...free];
    let prev = positions(els);
    // the item moves: a free pin does not
    expect(rideAlong(move(els, 'item', 50, 0), prev, { now: NOW }).changed).toEqual([]);
    // mid-drag nothing is re-tied, and the drop still counts as a move
    const dragged = move(els, free[0].id, -780, -770);                 // now at 120, 130: on the item
    let r = rideAlong(dragged, prev, { dragging: true, now: NOW });
    expect(r.changed).toEqual([]);
    r = rideAlong(dragged, r.next, { now: NOW });
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].customData.nexusOn).toEqual({ id: 'item', dx: 20, dy: 30 });
    expect(r.changed[0].customData.nexusComment).toBe(1);              // still the same pin
    els = apply(dragged, r.changed);
    // dragged off again: free
    const off = move(els, free[0].id, 2000, 0);
    r = rideAlong(off, r.next, { now: NOW });
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].customData.nexusOn).toBeUndefined();
  });

  it('a pin whose item was deleted stays where it is; a reply or Resolve keeps the pin tied', () => {
    const item = box('item', 100, 100);
    const pin = tiePin(commentPin({ x: 130, y: 120, text: 'Fix', number: 1, now: NOW, thread: newThread('Fix', who, NOW) }), item);
    const els = [item, ...pin];
    const prev = positions(els);
    const gone = els.map((e) => (e.id === 'item' ? { ...e, isDeleted: true, x: 999 } : e));
    expect(rideAlong(gone, prev, { now: NOW }).changed).toEqual([]);
    const part = pinParts(els).get(pin[0].id);
    const replied = withThread(els, pin[0].id, withReply(threadOf(part), 'On it', who, NOW), { now: NOW });
    const again = replied.find((e) => e.id === pin[0].id);
    expect(isPin(again)).toBe(true);
    expect(again.customData.nexusOn).toEqual({ id: 'item', dx: 30, dy: 20 });
    expect(again.customData.nexusThread.replies).toHaveLength(1);
  });

  it('Sort moves the stickies and what rides on them comes too: a pin and a vote line', () => {
    const a = sticky({ x: 0, y: 0, text: 'a', colorKey: 'yellow', now: NOW });
    const b = sticky({ x: 900, y: 300, text: 'b', colorKey: 'pink', now: NOW });
    const pin = tiePin(commentPin({ x: 950, y: 320, text: 'Why?', number: 1, now: NOW }), b[0]);
    const voted = stampVotes([...a, ...b, ...pin], new Map([[b[0].id, [{ email: 'ana@x.com', name: 'Ana Ruiz' }]]]), { now: NOW });
    const line = voted.find((e) => e.customData?.nexusVoteLine === b[0].id);
    const prev = positions(voted);
    const sorted = sortStickies(voted, null, 'color', { now: NOW });
    const r = rideAlong(sorted, prev, { now: NOW });
    const after = apply(sorted, r.changed);
    const moved = stickyParts(after).get(b[0].id).box;
    const [dx, dy] = [moved.x - b[0].x, moved.y - b[0].y];
    expect(dx !== 0 || dy !== 0).toBe(true);
    const p = after.find((e) => e.id === pin[0].id);
    expect([p.x, p.y]).toEqual([950 + dx, 320 + dy]);
    const l = after.find((e) => e.id === line.id);
    expect([l.x, l.y]).toEqual([line.x + dx, line.y + dy]);
    // and they stay ON TOP of the sticky they ride on (a sorted sticky is drawn again at the front)
    const top = after.indexOf(after.find((e) => e.id === b[0].id));
    expect(after.indexOf(p)).toBeGreaterThan(top);
    expect(after.indexOf(after.find((e) => e.containerId === pin[0].id))).toBeGreaterThan(top);
    expect(after.indexOf(l)).toBeGreaterThan(top);
  });
});
