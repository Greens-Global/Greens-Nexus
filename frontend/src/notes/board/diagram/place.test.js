import { describe, it, expect } from 'vitest';
import { prefixGraph, stampBoxes, stampOf, stampSelection, mergeBuilt, placeOrigin } from './place';

describe('place', () => {
  it('prefixes node and edge ids together', () => {
    const g = prefixGraph({ nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ from: 'n1', to: 'n2' }] }, 'dgX');
    expect(g.nodes.map((n) => n.id)).toEqual(['dgX:n1', 'dgX:n2']);
    expect(g.edges[0]).toMatchObject({ from: 'dgX:n1', to: 'dgX:n2' });
  });

  it('stamps boxes and finds the stamp from a selection', () => {
    const els = stampBoxes([{ id: 'a' }, { id: 'b', customData: { keep: 1 } }, { id: 'c' }], ['a', 'b'], { id: 's1', source: 'org', ref: 'x' });
    expect(els[1].customData).toEqual({ keep: 1, nexusDiagram: { id: 's1', source: 'org', ref: 'x' } });
    expect(els[2].customData).toBeUndefined();
    expect(stampOf(els, { c: true })).toBeNull();
    expect(stampOf(els, { b: true })).toMatchObject({ id: 's1' });
    expect(stampSelection([...els, { id: 'd', isDeleted: true, customData: { nexusDiagram: { id: 's1' } } }], 's1')).toEqual({ a: true, b: true });
  });

  it('swaps a rebuild in as newer versions and deletes what did not come back', () => {
    const current = [
      { id: 'a', version: 4, x: 0 },
      { id: 'arrow-old', version: 2 },
      { id: 'keep', version: 9 },
    ];
    const built = [{ id: 'a', version: 1, x: 50 }, { id: 'arrow-new', version: 1 }];
    const out = mergeBuilt(current, built, new Set(['a', 'arrow-old']));
    expect(out.map((e) => e.id)).toEqual(['a', 'arrow-old', 'keep', 'arrow-new']);
    expect(out[0]).toMatchObject({ x: 50, version: 5, isDeleted: false });
    expect(out[1]).toMatchObject({ isDeleted: true, version: 3 });
    expect(out[2]).toBe(current[2]);
  });

  it('centers a diagram on the view, or beside what is already drawn', () => {
    expect(placeOrigin({ x: 100, y: 100 }, { w: 40, h: 20 }, [])).toEqual({ x: 80, y: 90 });
    expect(placeOrigin({ x: 100, y: 100 }, { w: 40, h: 20 }, [{ x: 500, y: 0, width: 10, height: 10 }])).toEqual({ x: 80, y: 90 });
    expect(placeOrigin({ x: 100, y: 100 }, { w: 40, h: 20 }, [{ x: 90, y: 95, width: 10, height: 10 }, { x: 0, y: -50, width: 300, height: 10, isDeleted: false }]))
      .toEqual({ x: 460, y: -50 });
  });
});
