import { describe, it, expect } from 'vitest';
import { parseLength, formatLength, formatArea, formatScale, scaleAt, dimension, area, refreshMeasures } from './measure';

const scale = ({ pxPerFt, on = '', onW = 0, updated = 1, isDeleted = false }) => ({
  id: `s${updated}${on}`, type: 'arrow', x: 0, y: 0, points: [[0, 0], [pxPerFt, 0]], isDeleted, updated,
  customData: { nexusMeasure: { kind: 'scale', pxPerFt, on, onW } },
});
const image = (id, x, y, width, height, extra = {}) => ({ id, type: 'image', x, y, width, height, isDeleted: false, ...extra });

describe('parseLength', () => {
  it.each([
    ['24', 24], ['24.5', 24.5], ["24'", 24], ['24 ft', 24], ['24 feet', 24],
    ['24\' 6"', 24.5], ["24'6", 24.5], ['24\'-6"', 24.5], ['24 ft 6 in', 24.5],
    ['6"', 0.5], ['6 in', 0.5], ['  24 FT ', 24],
  ])('%s -> %s ft', (s, ft) => expect(parseLength(s)).toBeCloseTo(ft, 9));
  it.each([['7.5 m'], ['7.5m'], ['750 cm'], ['7500 mm']])('%s is 7.5 meters', (s) => expect(parseLength(s)).toBeCloseTo(7.5 / 0.3048, 9));
  it.each([[''], ['0'], ["0'"], ['-5'], ['-5 ft'], ['abc'], ['24 6'], ['ft'], ['12 yards'], [null], [undefined]])('rejects %s', (s) => {
    expect(parseLength(s)).toBeNull();
  });
});

describe('formatLength / formatArea / formatScale', () => {
  it('reads architectural feet and inches', () => {
    expect(formatLength(24.5)).toBe('24\' 6"');
    expect(formatLength(24)).toBe("24'");
    expect(formatLength(0.5)).toBe('6"');
    expect(formatLength(1240 + 3 / 12)).toBe('1,240\' 3"');
    expect(formatLength(1234567)).toBe("1,234,567'");
  });
  it('rounds to the nearest inch and carries into the next foot', () => {
    expect(formatLength(11.6 / 12)).toBe("1'");
    expect(formatLength(5 + 11.6 / 12)).toBe("6'");
    expect(formatLength(5 + 11.4 / 12)).toBe('5\' 11"');
  });
  it('reads square feet', () => {
    expect(formatArea(1240.4)).toBe('1,240 sq ft');
    expect(formatArea(8.54)).toBe('8.5 sq ft');
    expect(formatArea(12)).toBe('12 sq ft');
    expect(formatScale(12)).toBe('1 ft = 12.0 px');
  });
});

describe('scaleAt', () => {
  it('is null with no scale', () => {
    expect(scaleAt([], { x: 0, y: 0 })).toBeNull();
    expect(scaleAt([image('i1', 0, 0, 100, 100)], { x: 5, y: 5 })).toBeNull();
  });
  it('reads the newest live board-wide scale', () => {
    const els = [scale({ pxPerFt: 10, updated: 1 }), scale({ pxPerFt: 20, updated: 3 }), scale({ pxPerFt: 99, updated: 5, isDeleted: true })];
    expect(scaleAt(els, { x: 500, y: 500 })).toBe(20);
  });
  it('reads an image scale over the image, rescaled when the image was resized', () => {
    const els = [scale({ pxPerFt: 10 }), image('i1', 0, 0, 400, 300), scale({ pxPerFt: 8, on: 'i1', onW: 200, updated: 2 })];
    expect(scaleAt(els, { x: 50, y: 50 })).toBe(16);      // drawn at 200 wide, now 400
    expect(scaleAt(els, { x: 900, y: 50 })).toBe(10);     // off the image: board-wide
  });
  it('takes the top-most scaled image and ignores deleted ones', () => {
    const els = [
      image('a', 0, 0, 100, 100), image('b', 0, 0, 100, 100), image('c', 0, 0, 100, 100, { isDeleted: true }),
      scale({ pxPerFt: 5, on: 'a', onW: 100, updated: 1 }), scale({ pxPerFt: 7, on: 'b', onW: 100, updated: 1 }),
      scale({ pxPerFt: 9, on: 'c', onW: 100, updated: 1 }),
    ];
    expect(scaleAt(els, { x: 10, y: 10 })).toBe(7);
    els[1] = { ...els[1], isDeleted: true };
    expect(scaleAt(els, { x: 10, y: 10 })).toBe(5);
  });
});

describe('dimension / area', () => {
  it('builds a grouped arrow with bars and a label above it', () => {
    const [arrow, label] = dimension({ x1: 10, y1: 100, x2: 130, y2: 100, pxPerFt: 10, now: 7 });
    expect(arrow).toMatchObject({ type: 'arrow', x: 10, y: 100, width: 120, height: 0, points: [[0, 0], [120, 0]], startArrowhead: 'bar', endArrowhead: 'bar', strokeWidth: 2, roughness: 0, roundness: null, version: 1, updated: 7 });
    expect(arrow.customData.nexusMeasure).toEqual({ kind: 'length', pxPerFt: 10, on: '', onW: 0 });
    expect(label).toMatchObject({ type: 'text', text: "12'", fontSize: 16, textAlign: 'center', strokeColor: '#e03131', customData: { nexusMeasureLabel: arrow.id } });
    expect(label.y + label.height / 2).toBeCloseTo(100 - 14);
    expect(label.x + label.width / 2).toBeCloseTo(70);
    expect(arrow.groupIds).toHaveLength(1);
    expect(label.groupIds).toEqual(arrow.groupIds);
    expect(arrow.id).not.toBe(label.id);
    expect(dimension({ x1: 0, y1: 0, x2: 1, y2: 0, pxPerFt: 1, look: 'sketch' })[0].roughness).toBe(1);
  });
  it('builds a closed tinted polygon with its area at the centroid', () => {
    const [poly, label] = area({ points: [[100, 100], [300, 100], [300, 200], [100, 200]], pxPerFt: 10, color: '#1971c2', now: 3 });
    expect(poly).toMatchObject({ type: 'line', x: 100, y: 100, width: 200, height: 100, backgroundColor: '#e7f5ff', fillStyle: 'solid', opacity: 70 });
    expect(poly.points).toEqual([[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]]);
    expect(poly.customData.nexusMeasure).toEqual({ kind: 'area', pxPerFt: 10, on: '', onW: 0 });
    expect(label.text).toBe('200 sq ft');
    expect(label.x + label.width / 2).toBeCloseTo(200);
    expect(label.y + label.height / 2).toBeCloseTo(150);
    expect(label.groupIds).toEqual(poly.groupIds);
  });
});

describe('refreshMeasures', () => {
  it('is a no-op on a board that is up to date', () => {
    const els = [scale({ pxPerFt: 10 }), ...dimension({ x1: 0, y1: 0, x2: 100, y2: 0, pxPerFt: 10 }), ...area({ points: [[0, 0], [100, 0], [100, 100]], pxPerFt: 10 })];
    expect(refreshMeasures(els)).toEqual([]);
  });
  it('relabels a stretched arrow and skips deleted ones', () => {
    const [arrow, label] = dimension({ x1: 0, y1: 0, x2: 100, y2: 0, pxPerFt: 10 });
    const stretched = { ...arrow, points: [[0, 0], [250, 0]], width: 250 };
    const out = refreshMeasures([stretched, label], { now: 9 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: label.id, text: '25\'', originalText: '25\'', version: 2, updated: 9 });
    expect(out[0].x + out[0].width / 2).toBeCloseTo(125);
    expect(refreshMeasures([{ ...stretched, isDeleted: true }, label])).toEqual([]);
  });
  it('follows a recalibration: measures and labels take the new scale, the scale line keeps its own', () => {
    const [sArrow, sLabel] = dimension({ x1: 0, y1: 500, x2: 100, y2: 500, pxPerFt: 10, kind: 'scale', now: 1 });
    const [arrow, label] = dimension({ x1: 0, y1: 0, x2: 200, y2: 0, pxPerFt: 10, now: 1 });
    const [poly, aLabel] = area({ points: [[0, 0], [100, 0], [100, 100], [0, 100]], pxPerFt: 10, now: 1 });
    const [s2] = dimension({ x1: 0, y1: 600, x2: 100, y2: 600, pxPerFt: 20, kind: 'scale', now: 2 });
    const out = refreshMeasures([sArrow, sLabel, arrow, label, poly, aLabel, s2], { now: 5 });
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId[arrow.id].customData.nexusMeasure.pxPerFt).toBe(20);
    expect(byId[label.id].text).toBe("10'");
    expect(byId[poly.id].customData.nexusMeasure.pxPerFt).toBe(20);
    expect(byId[aLabel.id].text).toBe('25 sq ft');
    expect(byId[sArrow.id]).toBeUndefined();
    expect(byId[sLabel.id]).toBeUndefined();
    expect(out).toHaveLength(4);
  });
});
