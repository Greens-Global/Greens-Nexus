// Arrange (Neil, 11/12/2026): Tidy Up for anything, Align and Space Evenly.
import { describe, it, expect } from 'vitest';
import { arrange, unitsOf, ARRANGE_GAP, ARRANGE_ACTIONS } from './arrange';
import { sticky, stickyParts, STICKY_SIZE } from './stickies';
import { commentPin } from './markupTools';

const NOW = 1_800_000_000_000;
const box = (id, x, y, w = 100, h = 60, extra = {}) => ({ id, type: 'rectangle', x, y, width: w, height: h, version: 1, groupIds: [], frameId: null, ...extra });
const sel = (...ids) => Object.fromEntries(ids.map((id) => [id, true]));
const at = (els, id) => { const e = els.find((x) => x.id === id); return [e.x, e.y]; };
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('arrange', () => {
  it('a unit is a sticky with its words, a box with its label, a group, or a section with what it holds', () => {
    const s = sticky({ x: 0, y: 0, text: 'a', now: NOW });
    const label = { id: 'lbl', type: 'text', x: 410, y: 20, width: 40, height: 20, containerId: 'b', version: 1, groupIds: [] };
    const sec = { id: 'sec', type: 'frame', x: 1000, y: 0, width: 400, height: 300, version: 1, groupIds: [] };
    const held = box('held', 1020, 20, 100, 60, { frameId: 'sec' });
    const els = [...s, box('b', 400, 0), label, sec, held, ...commentPin({ x: 10, y: 10, text: 'x', number: 1, now: NOW })];
    // picked by any part: the sticky's words alone still mean the whole sticky
    const { units } = unitsOf(els, sel(s[1].id, 'lbl', 'sec', 'held'));
    expect(units.map((u) => u.members.map((m) => m.id).sort())).toEqual([[...s.map((e) => e.id)].sort(), ['b', 'lbl'], ['held', 'sec']]);
    expect(units[2].section).toBe(true);        // `held` travels with its section, not by itself
    // a comment pin is never a unit of its own - it rides on its item
    expect(unitsOf(els, sel(els[els.length - 2].id)).units).toEqual([]);
  });

  it('Tidy Up: a pile becomes even rows with one gap, no overlaps, and nothing is made again', () => {
    const pile = [0, 1, 2, 3, 4, 5].flatMap((i) => sticky({ x: 100 + i * 7, y: 100 + i * 5, text: `s${i}`, now: NOW }));
    const ids = sel(...pile.filter((e) => e.customData?.nexusSticky).map((e) => e.id));
    const r = arrange(pile, ids, 'tidy', { now: NOW });
    expect(r.moved).toBe(5);                                    // the first one was already where it belongs
    expect(r.elements.map((e) => e.id)).toEqual(pile.map((e) => e.id));
    const boxes = [...stickyParts(r.elements).values()].map((p) => p.box);
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(overlap(a, b)).toBe(false);
    const xs = [...new Set(boxes.map((b) => b.x))].sort((a, b) => a - b);
    expect(xs.slice(1).map((x, i) => x - xs[i])).toEqual(xs.slice(1).map(() => STICKY_SIZE + ARRANGE_GAP));
    expect(new Set(boxes.map((b) => b.y)).size).toBeGreaterThan(1);    // wrapped: not one long row
    // every part of a sticky moved by the same amount
    for (const [id, p] of stickyParts(r.elements)) {
      const was = stickyParts(pile).get(id);
      expect([p.text.x - was.text.x, p.foot.y - was.foot.y]).toEqual([p.box.x - was.box.x, p.box.y - was.box.y]);
    }
    // tidy again: nothing left to do
    const again = arrange(r.elements, ids, 'tidy', { now: NOW });
    expect(again.moved).toBe(0);
    expect(again.elements).toBe(r.elements);
  });

  it('Tidy Up keeps the rows a person already sees, in order', () => {
    const els = [box('a', 0, 0), box('b', 300, 8), box('c', 20, 200), box('d', 500, 190)];
    const r = arrange(els, sel('a', 'b', 'c', 'd'), 'tidy', { now: NOW });
    expect(at(r.elements, 'a')).toEqual([0, 0]);
    expect(at(r.elements, 'b')).toEqual([100 + ARRANGE_GAP, 0]);
    expect(at(r.elements, 'c')).toEqual([0, 60 + ARRANGE_GAP]);
    expect(at(r.elements, 'd')).toEqual([100 + ARRANGE_GAP, 60 + ARRANGE_GAP]);
  });

  it('a section picked alone is tidied inside itself, strays pulled in, and it grows to hold them', () => {
    const sec = { id: 'sec', type: 'frame', x: 0, y: 0, width: 300, height: 200, version: 1, groupIds: [], name: 'Wins' };
    const els = [sec, box('a', 20, 20, 100, 60, { frameId: 'sec' }), box('b', 40, 30, 100, 60, { frameId: 'sec' }),
      box('c', 250, 170, 100, 60, { frameId: 'sec' }), box('out', 900, 900)];
    const r = arrange(els, sel('sec'), 'tidy', { now: NOW });
    const f = r.elements.find((e) => e.id === 'sec');
    for (const id of ['a', 'b', 'c']) {
      const e = r.elements.find((x) => x.id === id);
      expect(e.x).toBeGreaterThanOrEqual(f.x + 24);
      expect(e.x + e.width).toBeLessThanOrEqual(f.x + f.width - 24 + 0.5);
      expect(e.y + e.height).toBeLessThanOrEqual(f.y + f.height - 24 + 0.5);
    }
    expect(f.height).toBeGreaterThanOrEqual(200);
    expect([f.x, f.y]).toEqual([0, 0]);                          // the section itself stays put
    expect(at(r.elements, 'out')).toEqual([900, 900]);           // not in it, not touched
  });

  it('Align and Space Evenly move whole units; boxes joined by arrows are left to the diagram Tidy Up', () => {
    const els = [box('a', 0, 0), box('b', 300, 40, 50, 30), box('c', 140, 90)];
    const left = arrange(els, sel('a', 'b', 'c'), 'left', { now: NOW }).elements;
    expect(['a', 'b', 'c'].map((id) => at(left, id)[0])).toEqual([0, 0, 0]);
    const mid = arrange(els, sel('a', 'b', 'c'), 'middle', { now: NOW }).elements;
    expect(['a', 'b', 'c'].map((id) => { const e = mid.find((x) => x.id === id); return e.y + e.height / 2; })).toEqual([75, 75, 75]);
    const spread = arrange(els, sel('a', 'b', 'c'), 'spread-x', { now: NOW }).elements;
    const [a, c, b] = ['a', 'c', 'b'].map((id) => spread.find((x) => x.id === id));
    expect(c.x - (a.x + a.width)).toBeCloseTo(b.x - (c.x + c.width), 5);
    expect([a.x, b.x]).toEqual([0, 300]);                        // the two ends stay
    expect(arrange(els, sel('a', 'b'), 'spread-x').moved).toBe(0);   // needs three
    const tied = [box('p', 0, 0, 100, 60, { boundElements: [{ id: 'ar', type: 'arrow' }] }), box('q', 300, 50)];
    const r = arrange(tied, sel('p', 'q'), 'top', { now: NOW });
    expect(r.skipped).toBe(1);
    expect(r.elements).toBe(tied);
    expect(ARRANGE_ACTIONS.map((x) => x.label)).toContain('Tidy Up');
    // an element the engine reports with no groupIds at all is still a unit
    expect(unitsOf([{ id: 'n', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }], sel('n')).units).toHaveLength(1);
  });
});
