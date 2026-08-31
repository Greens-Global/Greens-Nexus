import { describe, it, expect } from 'vitest';
import { rangeBetween, selectionAfterClick, selectionAfterArrow } from './rowSelection';

// The gestures people bring from Excel. The cases that matter are the ones
// where the anchor and the focus disagree - overshooting a shift-click and
// coming back, and walking a range with shift+arrow past where it started.

const IDS = ['a', 'b', 'c', 'd', 'e'];
const sel = (...ids) => new Set(ids);
const click = (over) => selectionAfterClick({ selected: sel(), orderedIds: IDS, ...over });
const arrow = (over) => selectionAfterArrow({ selected: sel(), orderedIds: IDS, ...over });

describe('rangeBetween', () => {
  it('reads in list order whichever way round the ends are', () => {
    expect(rangeBetween(IDS, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(IDS, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('is a single row when both ends are the same', () => {
    expect(rangeBetween(IDS, 'c', 'c')).toEqual(['c']);
  });

  it('is empty when an end is not in the list', () => {
    // A row filtered out from under the selection cannot anchor a range.
    expect(rangeBetween(IDS, 'zz', 'c')).toEqual([]);
    expect(rangeBetween(IDS, 'c', undefined)).toEqual([]);
  });
});

describe('plain and ctrl click', () => {
  it('toggles the row and plants the anchor', () => {
    const r = click({ id: 'c' });
    expect([...r.selected]).toEqual(['c']);
    expect(r.anchorId).toBe('c');
    expect(r.focusId).toBe('c');
  });

  it('toggles a selected row back off', () => {
    const r = click({ selected: sel('a', 'c'), id: 'c' });
    expect([...r.selected]).toEqual(['a']);
  });

  it('ctrl+click adds without disturbing the rest', () => {
    const r = click({ selected: sel('a'), id: 'd', ctrl: true });
    expect([...r.selected].sort()).toEqual(['a', 'd']);
    expect(r.anchorId).toBe('d');
  });

  it('moves the anchor to each new click', () => {
    const first = click({ id: 'b' });
    const second = click({ selected: first.selected, anchorId: first.anchorId, id: 'd', ctrl: true });
    expect(second.anchorId).toBe('d');
  });
});

describe('shift click', () => {
  it('selects the range from the anchor, replacing what was there', () => {
    const r = click({ selected: sel('a'), anchorId: 'b', id: 'd', shift: true });
    expect([...r.selected]).toEqual(['b', 'c', 'd']);   // 'a' is gone
  });

  it('works upwards as well as downwards', () => {
    const r = click({ anchorId: 'd', id: 'b', shift: true });
    expect([...r.selected]).toEqual(['b', 'c', 'd']);
  });

  it('keeps the anchor put, so overshooting and coming back re-measures', () => {
    const out = click({ anchorId: 'b', id: 'e', shift: true });
    expect([...out.selected]).toEqual(['b', 'c', 'd', 'e']);
    expect(out.anchorId).toBe('b');

    const back = click({ selected: out.selected, anchorId: out.anchorId, focusId: out.focusId, id: 'c', shift: true });
    expect([...back.selected]).toEqual(['b', 'c']);      // not ['c','d','e']
    expect(back.anchorId).toBe('b');
  });

  it('ctrl+shift adds the range to the existing selection', () => {
    const r = click({ selected: sel('a'), anchorId: 'c', id: 'd', shift: true, ctrl: true });
    expect([...r.selected].sort()).toEqual(['a', 'c', 'd']);
  });

  it('falls back to a plain toggle when there is no anchor yet', () => {
    // Holding shift for the very first click should still cost nothing.
    const r = click({ id: 'c', shift: true });
    expect([...r.selected]).toEqual(['c']);
    expect(r.anchorId).toBe('c');
  });

  it('falls back to a toggle when the anchor has been filtered away', () => {
    const r = click({ anchorId: 'gone', id: 'c', shift: true });
    expect([...r.selected]).toEqual(['c']);
    expect(r.anchorId).toBe('c');
  });
});

describe('shift + arrow', () => {
  it('extends the range one row down and reports where it landed', () => {
    const r = arrow({ selected: sel('b'), anchorId: 'b', focusId: 'b', dir: 1 });
    expect([...r.selected]).toEqual(['b', 'c']);
    expect(r.movedTo).toBe('c');
    expect(r.anchorId).toBe('b');
  });

  it('walks further on each press', () => {
    let r = arrow({ selected: sel('b'), anchorId: 'b', focusId: 'b', dir: 1 });
    r = selectionAfterArrow({ selected: r.selected, orderedIds: IDS, anchorId: r.anchorId, focusId: r.focusId, dir: 1 });
    expect([...r.selected]).toEqual(['b', 'c', 'd']);
  });

  it('shrinks the range back when the direction reverses', () => {
    // Grown b..d, now shift+up: the far end comes back to c rather than the
    // range growing upwards past the anchor.
    const r = arrow({ selected: sel('b', 'c', 'd'), anchorId: 'b', focusId: 'd', dir: -1 });
    expect([...r.selected]).toEqual(['b', 'c']);
  });

  it('crosses the anchor and grows the other way', () => {
    const r = arrow({ selected: sel('c'), anchorId: 'c', focusId: 'c', dir: -1 });
    expect([...r.selected]).toEqual(['b', 'c']);
  });

  it('does nothing at the top or the bottom', () => {
    expect(arrow({ selected: sel('a'), anchorId: 'a', focusId: 'a', dir: -1 }).movedTo).toBeNull();
    expect(arrow({ selected: sel('e'), anchorId: 'e', focusId: 'e', dir: 1 }).movedTo).toBeNull();
  });

  it('does nothing until a click has planted an anchor', () => {
    // Otherwise shift+arrow would hijack a scroll to select a row nobody asked
    // for. The caller leaves the keystroke to the browser when movedTo is null.
    const r = arrow({ dir: 1 });
    expect(r.movedTo).toBeNull();
    expect([...r.selected]).toEqual([]);
  });

  it('does nothing when the anchor has been filtered away', () => {
    expect(arrow({ selected: sel('c'), anchorId: 'gone', focusId: 'c', dir: 1 }).movedTo).toBeNull();
  });

  it('falls back to the anchor when the focus row has been filtered away', () => {
    const r = arrow({ selected: sel('b'), anchorId: 'b', focusId: 'gone', dir: 1 });
    expect([...r.selected]).toEqual(['b', 'c']);
  });
});
