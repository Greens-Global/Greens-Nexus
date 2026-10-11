import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import TabInk from './TabInk';

// jsdom has no layout; give each button an offset box from a data attribute.
const geom = {};
beforeAll(() => {
  for (const [prop, key] of [['offsetLeft', 'x'], ['offsetWidth', 'w'], ['offsetTop', 'y'], ['offsetHeight', 'h']]) {
    geom[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() { const v = this.dataset?.[key]; return v == null ? 0 : Number(v); },
    });
  }
});
afterAll(() => { for (const p of Object.keys(geom)) Object.defineProperty(HTMLElement.prototype, p, geom[p]); });

function Strip({ active, variant }) {
  return (
    <nav className="hdr-tabs">
      <TabInk active={active} variant={variant} />
      <button className={`hdr-tab${active === 'a' ? ' active' : ''}`} data-x="0" data-w="80" data-h="34">A</button>
      <button className={`hdr-tab${active === 'b' ? ' active' : ''}`} data-x="82" data-w="120" data-h="34">B</button>
    </nav>
  );
}

const ink = () => document.querySelector('.tab-ink');

describe('TabInk', () => {
  it('stays hidden when no tab is active', () => {
    render(<Strip active="zzz" />);
    expect(ink().hidden).toBe(true);
  });

  it('sits under the active tab, jumps on first paint, glides on the next change', () => {
    const { rerender } = render(<Strip active="a" />);
    expect(ink().hidden).toBe(false);
    expect(ink().style.transform).toBe('translate(0px, 0px)');
    expect(ink().style.width).toBe('80px');
    expect(ink().className).not.toContain('tab-ink--glide');
    expect(ink().getAttribute('aria-hidden')).toBe('true');
    rerender(<Strip active="b" />);
    expect(ink().style.transform).toBe('translate(82px, 0px)');
    expect(ink().style.width).toBe('120px');
    expect(ink().className).toContain('tab-ink--glide');
  });

  it('takes the underline variant for the phone strip', () => {
    render(<Strip active="a" variant="line" />);
    expect(ink().className).toContain('tab-ink--line');
  });
});
