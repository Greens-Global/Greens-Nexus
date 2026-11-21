import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOpenAtTop } from './openAtTop.js';

const scroller = () => document.scrollingElement || document.documentElement;
const mount = (k, h = null) => renderHook(({ k: key, h: hl }) => useOpenAtTop(key, hl), { initialProps: { k, h } });

describe('useOpenAtTop', () => {
  beforeEach(() => { scroller().scrollTop = 0; });

  it('starts a newly opened asset, a stepped-to asset and a new tab at the top', () => {
    const { rerender } = mount(null);
    scroller().scrollTop = 900;                      // the list, scrolled down
    rerender({ k: 'a1:property', h: null });
    expect(scroller().scrollTop).toBe(0);
    scroller().scrollTop = 1400;                     // down at Unit Mix, then J
    rerender({ k: 'a2:property', h: null });
    expect(scroller().scrollTop).toBe(0);
    scroller().scrollTop = 600;
    rerender({ k: 'a2:maintenance', h: null });
    expect(scroller().scrollTop).toBe(0);
  });

  it('leaves the list, the same asset and a fresh deep-link highlight alone', () => {
    const { rerender } = mount('a1:property');
    scroller().scrollTop = 500;
    rerender({ k: null, h: null });                  // back to the list
    expect(scroller().scrollTop).toBe(500);
    rerender({ k: 'a1:warranty', h: { item: 'Roof', at: 1 } });   // opened on a row to highlight
    expect(scroller().scrollTop).toBe(500);
    rerender({ k: 'a1:warranty', h: null });         // the 4s highlight ends
    expect(scroller().scrollTop).toBe(500);
  });

  it('a highlight still on screen from before does not stop the next asset opening at the top', () => {
    const hl = { item: 'Roof', at: 1 };
    const { rerender } = mount('a1:warranty', hl);
    scroller().scrollTop = 700;
    rerender({ k: 'a2:warranty', h: hl });
    expect(scroller().scrollTop).toBe(0);
  });
});
