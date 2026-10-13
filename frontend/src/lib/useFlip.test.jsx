import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useFlip, setMotionEnabled } from './motion';

// jsdom has no layout and no Web Animations: give every element a box from
// data attributes and record what animate() is asked for.
let calls = [];
const saved = {};
beforeAll(() => {
  saved.rect = HTMLElement.prototype.getBoundingClientRect;
  saved.animate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  HTMLElement.prototype.getBoundingClientRect = function () {
    const x = Number(this.dataset?.x || 0); const y = Number(this.dataset?.y || 0);
    return { left: x, top: y, right: x + 100, bottom: y + 36, width: 100, height: 36, x, y };
  };
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true, writable: true,
    value(keyframes, opts) { calls.push({ key: this.dataset.flip, keyframes, opts }); return { cancel() {} }; },
  });
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = saved.rect;
  if (saved.animate) Object.defineProperty(HTMLElement.prototype, 'animate', saved.animate);
  else delete HTMLElement.prototype.animate;
});
beforeEach(() => { calls = []; setMotionEnabled(true); });
afterEach(() => { cleanup(); setMotionEnabled(false); });

function List({ items }) {
  const ref = useRef(null);
  useFlip(ref);
  return (
    <div ref={ref}>
      {items.map((i) => <div key={i.id ?? i.k} data-flip={i.k} data-x={i.x || 0} data-y={i.y}>{i.k}</div>)}
    </div>
  );
}

const rows = (...ks) => ks.map((k, i) => ({ k, y: i * 40 }));

describe('useFlip', () => {
  it('seeds its cache silently on first paint', () => {
    render(<List items={rows('a', 'b')} />);
    expect(calls).toEqual([]);
  });

  it('glides reordered items from where they were', () => {
    const { rerender } = render(<List items={rows('a', 'b')} />);
    rerender(<List items={rows('b', 'a')} />);
    const a = calls.find((c) => c.key === 'a');
    const b = calls.find((c) => c.key === 'b');
    expect(a.keyframes[0].transform).toBe('translate(0px, -40px)');
    expect(a.keyframes[1].transform).toBe('none');
    expect(b.keyframes[0].transform).toBe('translate(0px, 40px)');
    expect(a.opts.duration).toBe(220);
  });

  it('fades a newly added item in and leaves the untouched ones alone', () => {
    const { rerender } = render(<List items={rows('a', 'b')} />);
    rerender(<List items={rows('a', 'b', 'c')} />);
    expect(calls.map((c) => c.key)).toEqual(['c']);
    expect(calls[0].keyframes[0].opacity).toBe(0);
    expect(calls[0].opts.duration).toBe(150);
  });

  it('treats a burst of new items as a load, not an add', () => {
    const { rerender } = render(<List items={rows('a')} />);
    rerender(<List items={rows('a', ...Array.from({ length: 13 }, (_, i) => `n${i}`))} />);
    expect(calls).toEqual([]);
  });

  it('skips an ambiguous key that appears twice', () => {
    const { rerender } = render(<List items={[{ k: 'a', y: 0 }, { k: 'b', y: 40 }]} />);
    rerender(<List items={[{ k: 'b', y: 0 }, { k: 'a', y: 40 }, { k: 'a', y: 80, id: 'a2' }]} />);
    expect(calls.map((c) => c.key)).toEqual(['b']);
  });

  it('tags its own animations and leaves CSS transitions alone', () => {
    const cancelled = [];
    const { rerender } = render(<List items={rows('a', 'b')} />);
    // 'a' has a hover transition running (a CSSTransition has no id).
    const a = document.querySelector('[data-flip="a"]');
    a.getAnimations = () => [{ id: '', cancel() { cancelled.push('css'); } }];
    rerender(<List items={rows('b', 'a')} />);
    expect(cancelled).toEqual([]);
    expect(calls.every((c) => c.opts.id === 'nx-flip')).toBe(true);
    expect(calls.find((c) => c.key === 'a').keyframes[0].transform).toBe('translate(0px, -40px)');
  });

  it('does nothing when motion is off', () => {
    setMotionEnabled(false);
    const { rerender } = render(<List items={rows('a', 'b')} />);
    rerender(<List items={rows('b', 'a')} />);
    expect(calls).toEqual([]);
  });

  it('does nothing under reduced motion', () => {
    const mm = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      const { rerender } = render(<List items={rows('a', 'b')} />);
      rerender(<List items={rows('b', 'a')} />);
      expect(calls).toEqual([]);
    } finally { window.matchMedia = mm; }
  });
});
