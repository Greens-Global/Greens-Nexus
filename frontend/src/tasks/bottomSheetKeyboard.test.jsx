import { describe, it, expect, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { BottomSheet } from './MobileTaskBar';

// iOS Safari slides the keyboard OVER the layout viewport instead of shrinking
// it, so a sheet pinned with `inset: 0` / `vh` sat behind the keyboard with
// only its header showing, and its body could not scroll (iPhone 14 / 17 Pro
// Max, Sept 28 2026). The sheet now follows the visual viewport - the part of
// the screen actually visible above the keyboard.

function fakeVisualViewport(height, offsetTop = 0) {
  const listeners = {};
  const vv = {
    height, offsetTop,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type) { (listeners[type] || []).forEach((f) => f()); },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

const overlay = () => document.querySelector('.nx-tasks-portal');
const panel = () => overlay().firstChild;
const body = () => panel().lastChild;

afterEach(() => { delete window.visualViewport; });

describe('BottomSheet with the keyboard open', () => {
  it('sizes itself to the visible viewport and follows it as the keyboard opens', () => {
    const vv = fakeVisualViewport(800);
    render(<BottomSheet title="New Task" onClose={() => {}}><input /></BottomSheet>);
    expect(overlay().style.height).toBe('800px');

    // Keyboard up: the visible area shrinks and Safari scrolls the page.
    act(() => { vv.height = 420; vv.offsetTop = 120; vv.fire('resize'); });
    expect(overlay().style.height).toBe('420px');
    expect(overlay().style.top).toBe('120px');
    expect(parseInt(panel().style.maxHeight, 10)).toBeLessThanOrEqual(420);
  });

  it('lets the body scroll inside the sheet instead of overflowing it', () => {
    fakeVisualViewport(600);
    render(<BottomSheet title="New Task" onClose={() => {}}><div style={{ height: 2000 }} /></BottomSheet>);
    expect(body().style.overflowY).toBe('auto');
    expect(body().style.minHeight).toMatch(/^0(px)?$/);
  });

  it('falls back to the full screen where visualViewport is missing', () => {
    render(<BottomSheet title="New Task" onClose={() => {}}><input /></BottomSheet>);
    expect(overlay().style.top).toBe('0px');
    expect(overlay().style.bottom).toBe('0px');
  });
});
