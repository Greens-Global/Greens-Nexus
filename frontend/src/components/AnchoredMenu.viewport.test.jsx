import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import AnchoredMenu from './AnchoredMenu';

// iOS pans the VISUAL viewport inside the layout viewport (keyboard up, pinch
// zoom). Trigger rects and position:fixed are layout-viewport coordinates, so
// the menu has to stay inside [offsetTop, offsetTop + height] x
// [offsetLeft, offsetLeft + width] - not [0, height] x [0, width].

const MENU_W = 150;
const MENU_H = 200;

function Harness({ rect, align = 'start' }) {
  const btn = useRef(null);
  return (
    <>
      <button ref={(el) => { btn.current = el; if (el) el.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top }); }}>More</button>
      <AnchoredMenu anchorRef={btn} open onClose={() => {}} align={align}>
        <div>Row</div>
      </AnchoredMenu>
    </>
  );
}

const origW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const origH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
const origVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const origIw = window.innerWidth;
const origIh = window.innerHeight;

function setup({ vv, innerWidth = 1024, innerHeight = 768 }) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return this.getAttribute('role') === 'menu' ? MENU_W : 0; },
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true, get() { return this.getAttribute('role') === 'menu' ? MENU_H : 0; },
  });
  window.innerWidth = innerWidth;
  window.innerHeight = innerHeight;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: vv ? { ...vv, addEventListener() {}, removeEventListener() {} } : undefined,
  });
}

afterEach(() => {
  cleanup();
  if (origW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origW);
  else delete HTMLElement.prototype.offsetWidth;
  if (origH) Object.defineProperty(Element.prototype, 'scrollHeight', origH);
  else delete Element.prototype.scrollHeight;
  if (origVv) Object.defineProperty(window, 'visualViewport', origVv);
  else delete window.visualViewport;
  window.innerWidth = origIw;
  window.innerHeight = origIh;
});

const box = (menu) => ({
  left: parseFloat(menu.style.left), top: parseFloat(menu.style.top), maxHeight: parseFloat(menu.style.maxHeight),
});

describe('AnchoredMenu inside a panned visual viewport', () => {
  const desktopRect = { top: 100, bottom: 130, left: 200, right: 300 };

  it('desktop (no visualViewport, or one with no pan) places identically', () => {
    setup({ vv: null });
    render(<Harness rect={desktopRect} align="end" />);
    const plain = box(screen.getByRole('menu'));
    cleanup();

    setup({ vv: { offsetTop: 0, offsetLeft: 0, width: 1024, height: 768 } });
    render(<Harness rect={desktopRect} align="end" />);
    expect(box(screen.getByRole('menu'))).toEqual(plain);
    // Below the trigger, right edge on the trigger's right edge.
    expect(plain).toEqual({ left: 300 - MENU_W, top: 136, maxHeight: 768 - 130 - 6 - 8 });
  });

  it('keyboard up: flips and clamps against the visible band, not the layout top', () => {
    // Layout viewport 390x844; the keyboard leaves 300px visible, panned down 300.
    setup({ innerWidth: 390, innerHeight: 844, vv: { offsetTop: 300, offsetLeft: 0, width: 390, height: 300 } });
    // Trigger near the bottom of what is visible (300..600).
    render(<Harness rect={{ top: 500, bottom: 530, left: 20, right: 120 }} />);
    const b = box(screen.getByRole('menu'));
    // Room below the trigger inside the band: 600 - 530 - 6 - 8 = 56; above: 500 - 300 - 14 = 186.
    expect(b.maxHeight).toBe(186);
    // Opens upward and its top stops at the band's top edge (300 + 8), not
    // at 294 - which is hidden above the visible area.
    expect(b.top).toBe(308);
  });

  it('pinch zoom panned sideways: horizontal clamp uses offsetLeft', () => {
    setup({ innerWidth: 390, innerHeight: 844, vv: { offsetTop: 0, offsetLeft: 100, width: 200, height: 400 } });
    // Visible columns are 100..300; a trigger at 250 would push a 150px menu past 300.
    render(<Harness rect={{ top: 50, bottom: 80, left: 250, right: 290 }} />);
    // Right clamp: 100 + 200 - 8 - 150 = 142 (the old math said 42, off the
    // visible band's left edge).
    expect(box(screen.getByRole('menu')).left).toBe(142);
  });

  it('pinch zoom: never left of the visible band', () => {
    setup({ innerWidth: 390, innerHeight: 844, vv: { offsetTop: 0, offsetLeft: 100, width: 200, height: 400 } });
    render(<Harness rect={{ top: 50, bottom: 80, left: 60, right: 110 }} align="end" />);
    // align end wants 110 - 150 = -40; the band's left edge + 8 wins.
    expect(box(screen.getByRole('menu')).left).toBe(108);
  });
});
