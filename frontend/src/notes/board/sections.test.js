// Sections on a Board (Neil, 11/12/2026) - the pure part.
import { describe, it, expect } from 'vitest';
import { sections, sectionAt, sectionOf, sectionName, placeInSection } from './sections';

const frame = (id, x, y, w, h, name = '') => ({ id, type: 'frame', x, y, width: w, height: h, name, version: 1 });
const box = (id, x, y, w = 200, h = 200, extra = {}) => ({ id, type: 'rectangle', x, y, width: w, height: h, version: 1, frameId: null, ...extra });

describe('sections', () => {
  it('are read in the order Present reads them: rows top to bottom, each left to right', () => {
    const els = [frame('c', 0, 800, 300, 300, 'Third'), frame('b', 400, 10, 300, 300, 'Second'), frame('a', 0, 0, 300, 300, 'First'),
      { ...frame('gone', 0, 0, 10, 10), isDeleted: true }, box('x', 0, 0)];
    expect(sections(els).map((f) => f.name)).toEqual(['First', 'Second', 'Third']);
    expect(sectionName(frame('n', 0, 0, 1, 1, '  '))).toBe('Section');
  });

  it('a thing belongs to its frame, else to the section its middle sits in, else to none', () => {
    const els = [frame('a', 0, 0, 400, 400), frame('b', 500, 0, 400, 400)];
    expect(sectionAt(els, { x: 100, y: 100 })).toBe('a');
    expect(sectionAt(els, { x: 450, y: 100 })).toBe('');
    expect(sectionOf(els, box('s', 520, 20, 200, 200, { frameId: 'a' }))).toBe('a');      // its frame wins
    expect(sectionOf(els, box('s', 520, 20))).toBe('b');                                   // placed before sections carried members
    expect(sectionOf(els, box('s', 2000, 20))).toBe('');
    expect(sectionOf(els, box('s', 520, 20, 200, 200, { frameId: 'deleted-one' }))).toBe('b');
  });

  it('a new sticky lands fully inside the section under it, never cut off by its edge', () => {
    const els = [frame('a', 0, 0, 400, 400), frame('tiny', 1000, 0, 150, 150)];
    // near the bottom-right corner: moved in
    expect(placeInSection(els, { x: 250, y: 300, width: 200, height: 200 })).toEqual({ x: 188, y: 188, frameId: 'a' });
    // already inside: left where it was put
    expect(placeInSection(els, { x: 50, y: 60, width: 200, height: 200 })).toEqual({ x: 50, y: 60, frameId: 'a' });
    // a section too small to hold it does not take it; open board takes it as it is
    expect(placeInSection(els, { x: 990, y: -20, width: 200, height: 200 })).toEqual({ x: 990, y: -20, frameId: null });
    expect(placeInSection(els, { x: 3000, y: 0, width: 200, height: 200 })).toEqual({ x: 3000, y: 0, frameId: null });
  });
});
