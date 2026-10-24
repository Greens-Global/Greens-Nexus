import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import Overlay from './Overlay';

// The drawing layer: a pointerdown followed straight by a pointerup - no
// pointermove in between (a fast flick, some pens and trackpads, automation)
// - still yields the item, sized from where the pointer came up.

afterEach(cleanup);

// jsdom has no PointerEvent; without one, fireEvent falls back to a plain
// Event and the coordinates never reach the handler. A MouseEvent carries
// clientX / clientY / button, plus the two pointer fields the Overlay reads.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; }
  };
}

const down = (el, x, y, extra = {}) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', ...extra });
const up = (el, x, y, extra = {}) => fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', ...extra });

describe('Overlay drawing', () => {
  it('rect: pointerdown + pointerup with no move adds one rect sized to the release point', () => {
    const onAdd = vi.fn();
    render(<Overlay tool="rect" color="#ef4444" items={[]} onAdd={onAdd} onPick={vi.fn()} />);
    const layer = screen.getByTestId('bm-overlay');
    down(layer, 10, 20);
    up(layer, 60, 50);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toMatchObject({ type: 'rect', x: 10, y: 20, w: 50, h: 30, color: '#ef4444', width: 3 });
    expect(onAdd.mock.calls[0][0]._x0).toBeUndefined();
  });

  it('arrow and path the same way; a zero-length arrow or a bare tap adds nothing', () => {
    const onAdd = vi.fn();
    const { rerender } = render(<Overlay tool="arrow" color="#3b82f6" items={[]} onAdd={onAdd} onPick={vi.fn()} />);
    const layer = screen.getByTestId('bm-overlay');
    down(layer, 0, 0); up(layer, 40, 40);
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'arrow', x1: 0, y1: 0, x2: 40, y2: 40 }));
    down(layer, 5, 5); up(layer, 5, 5);
    expect(onAdd).toHaveBeenCalledTimes(1);
    rerender(<Overlay tool="path" color="#3b82f6" items={[]} onAdd={onAdd} onPick={vi.fn()} />);
    down(layer, 1, 1); up(layer, 9, 9);
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'path', points: [[1, 1], [9, 9]] }));
  });

  it('pin tool: a down + up far apart is a region pick sized from the release point', () => {
    const onPick = vi.fn();
    // regionTarget samples elementsFromPoint, which jsdom lacks - a stub keeps the geometry under test.
    document.elementsFromPoint = () => [document.body];
    render(<Overlay tool="pin" color="#ef4444" items={[]} onAdd={vi.fn()} onPick={onPick} />);
    const layer = screen.getByTestId('bm-overlay');
    down(layer, 100, 100); up(layer, 300, 220);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][2]).toBe('region');
    expect(onPick.mock.calls[0][1]).toMatchObject({ x: 100, y: 100, w: 200, h: 120 });
    delete document.elementsFromPoint;
  });

  it('items are stored in page coordinates: a scrolled page adds its offset, and the layer draws them back at the viewport spot', () => {
    const onAdd = vi.fn();
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
    try {
      const { container, rerender } = render(<Overlay tool="redact" color="#ef4444" items={[]} onAdd={onAdd} onPick={vi.fn()} />);
      const layer = screen.getByTestId('bm-overlay');
      down(layer, 10, 20); up(layer, 60, 50);
      expect(onAdd).toHaveBeenCalledTimes(1);
      const item = onAdd.mock.calls[0][0];
      expect(item).toMatchObject({ type: 'redact', x: 10, y: 1020, w: 50, h: 30 });
      // Rendered against the current scroll it sits where it was drawn.
      rerender(<Overlay tool="redact" color="#ef4444" items={[item]} onAdd={onAdd} onPick={vi.fn()} />);
      const rect = container.querySelector('svg rect[fill="url(#bm-redact)"]');
      expect(rect.getAttribute('x')).toBe('10');
      expect(rect.getAttribute('y')).toBe('20');
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('nothing is drawn while not interactive', () => {
    const onAdd = vi.fn();
    render(<Overlay tool="rect" color="#ef4444" interactive={false} items={[]} onAdd={onAdd} onPick={vi.fn()} />);
    const layer = screen.getByTestId('bm-overlay');
    down(layer, 10, 20); up(layer, 60, 50);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
