import { describe, it, expect } from 'vitest';
import {
  MARKUP_TOOLS, MORE_TOOLS, strokeStyle, toolFromEngine, commentPin, wrapWords, nextCommentNumber, stageToBoard, restyle, removeSelected, colorByKey, PIN_MAX, sizeByKey, isSizeKey,
} from './markupTools';
import { FONT_HAND, FONT_SANS } from './scene';

describe('markup tools', () => {
  it('offers the reviewer set, in order', () => {
    // Section (the engine's frame) joined the bar on 11/12/2026 - Neil: "Section can join the main bar".
    expect(MARKUP_TOOLS.map((t) => t.key)).toEqual(['select', 'hand', 'pen', 'highlight', 'sticky', 'arrow', 'box', 'frame', 'text', 'comment', 'eraser']);
    expect(MARKUP_TOOLS.find((t) => t.key === 'frame')).toMatchObject({ label: 'Section', engine: 'frame' });
    expect(MORE_TOOLS.some((t) => t.key === 'frame')).toBe(false);
  });

  it('draws the highlighter wide and see-through, the pen solid at the picked width', () => {
    expect(strokeStyle('highlight', 'yellow', 'fine')).toMatchObject({ currentItemStrokeColor: colorByKey('yellow').color, currentItemStrokeWidth: 4, currentItemOpacity: 35 });
    expect(strokeStyle('pen', 'red', 'bold')).toMatchObject({ currentItemStrokeColor: '#e03131', currentItemStrokeWidth: 4, currentItemOpacity: 100 });
    expect(strokeStyle('box', 'blue', 'fine').currentItemStrokeWidth).toBe(1);
    expect(strokeStyle('pen', 'red', 9).currentItemStrokeWidth).toBe(9);
    expect(strokeStyle('pen', 'red', 99).currentItemStrokeWidth).toBe(24);
    expect(sizeByKey(4)).toBe(sizeByKey('bold'));
    expect(isSizeKey(7)).toBe(true);
    expect(isSizeKey('huge')).toBe(false);
    expect(isSizeKey(NaN)).toBe(false);
  });

  it('reads the engine tool back without losing pen vs highlighter or comment', () => {
    expect(toolFromEngine('freedraw', 'highlight')).toBe('highlight');
    expect(toolFromEngine('freedraw', 'box')).toBe('pen');
    expect(toolFromEngine('selection', 'comment')).toBe('comment');
    expect(toolFromEngine('selection', 'pen')).toBe('select');
    expect(toolFromEngine('rectangle', 'pen')).toBe('box');
    expect(toolFromEngine('diamond', 'pen')).toBe('diamond');
    expect(toolFromEngine('embeddable', 'pen')).toBeNull();
    expect(toolFromEngine(undefined, 'pen')).toBeNull();
  });

  it('numbers pins after the highest live one', () => {
    const els = [{ id: 'a', customData: { nexusComment: 2 } }, { id: 'b', customData: { nexusComment: 5 }, isDeleted: true }, { id: 'c' }];
    expect(nextCommentNumber(els)).toBe(3);
    expect(nextCommentNumber([])).toBe(1);
  });

  it('builds a pin as a tinted box with its numbered text bound inside', () => {
    const [box, text] = commentPin({ x: 10, y: 20, text: '  Raise this  ', number: 4, colorKey: 'blue', look: 'sketch' });
    expect(box).toMatchObject({ type: 'rectangle', x: 10, y: 20, backgroundColor: colorByKey('blue').tint, strokeColor: colorByKey('blue').color, roughness: 1 });
    expect(box.boundElements).toEqual([{ id: text.id, type: 'text' }]);
    expect(text).toMatchObject({ type: 'text', containerId: box.id, text: '4. Raise this', originalText: '4. Raise this', fontFamily: FONT_HAND, textAlign: 'center' });
    // the text sits centered in its box, which is sized to the words
    expect(text.x - box.x).toBeCloseTo(box.x + box.width - (text.x + text.width));
    expect(box.height).toBe(text.height + 20);
    expect(box.customData.nexusComment).toBe(4);
    const [, clean] = commentPin({ x: 0, y: 0, text: 'x'.repeat(PIN_MAX + 50), number: 1 });
    expect(clean.fontFamily).toBe(FONT_SANS);
    expect(clean.originalText.length).toBe(PIN_MAX + 3);
    expect(clean.text.split('\n').length).toBeGreaterThan(1);
  });

  it('wraps at spaces under the width, a long word on its own line', () => {
    const m = (t) => t.length * 10;
    expect(wrapWords('aaa bbb ccc', 70, m)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapWords('x supercalifragilistic y', 50, m)).toEqual(['x', 'supercalifragilistic', 'y']);
  });

  it('maps a tap on the stage to a board point', () => {
    const p = stageToBoard({ clientX: 150, clientY: 250 }, { left: 50, top: 50 }, { zoom: { value: 2 }, scrollX: 10, scrollY: -20 });
    expect(p).toEqual({ x: 40, y: 120 });
  });

  it('re-inks only the selection, with a new version, keeping a pin text black', () => {
    const els = [
      { id: 'a', type: 'freedraw', strokeColor: '#000', strokeWidth: 1, version: 1 },
      { id: 'b', type: 'rectangle', strokeColor: '#000', strokeWidth: 1, version: 1 },
      { id: 't', type: 'text', strokeColor: '#1e1e1e', version: 1, customData: { nexusComment: 1 } },
    ];
    const next = restyle(els, { a: true, t: true }, { colorKey: 'red', sizeKey: 'bold' });
    expect(next[0]).toMatchObject({ strokeColor: '#e03131', strokeWidth: 4, version: 2 });
    expect(next[1]).toBe(els[1]);
    expect(next[2]).toBe(els[2]);
    expect(restyle(els, {}, { colorKey: 'red' })).toBe(els);
  });

  it('deletes the selection with a box and its bound text together', () => {
    const els = [
      { id: 't', type: 'text', containerId: 'b', version: 1 },
      { id: 'b', type: 'rectangle', boundElements: [{ id: 't', type: 'text' }], version: 1 },
      { id: 'x', type: 'arrow', version: 1 },
    ];
    const next = removeSelected(els, { b: true });
    expect(next.map((e) => !!e.isDeleted)).toEqual([true, true, false]);
    expect(next[0].version).toBe(2);
  });
});
