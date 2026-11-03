import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../api', () => ({ api: {} }));

import { hueCollidesWithLive, liveCollides, brandAccentCss, setBrandAccent, LIVE_COBALT } from './brandAccent';

// Live accent brand collision (Neil, 11/02/2026): an orange / red brand turns
// the live family cobalt so the brand and "in progress" never look alike.
describe('hueCollidesWithLive', () => {
  it('leaves green and blue brands on the orange live accent', () => {
    expect(hueCollidesWithLive('#1f7a44')).toBe(false);   // green
    expect(hueCollidesWithLive('#2b45e1')).toBe(false);   // cobalt blue
    expect(hueCollidesWithLive('#7c3aed')).toBe(false);   // purple
  });

  it('flags orange, red and pink brands', () => {
    expect(hueCollidesWithLive('#ee6a24')).toBe(true);    // orange
    expect(hueCollidesWithLive('#c2410c')).toBe(true);    // burnt orange
    expect(hueCollidesWithLive('#c8323f')).toBe(true);    // red
    expect(hueCollidesWithLive('#d6336c')).toBe(true);    // pink-red, hue ~339
    expect(hueCollidesWithLive('#f59e0b')).toBe(true);    // amber, hue ~38
  });

  it('ignores grays, near-blacks, pale washes and bad input', () => {
    expect(hueCollidesWithLive('#808080')).toBe(false);
    expect(hueCollidesWithLive('#26241f')).toBe(false);   // Warm sand's near-black
    expect(hueCollidesWithLive('#fff1ea')).toBe(false);   // a pale peach wash
    expect(hueCollidesWithLive('')).toBe(false);
    expect(hueCollidesWithLive('orange')).toBe(false);
  });

  it('accepts three-digit hex', () => {
    expect(hueCollidesWithLive('#f60')).toBe(true);
    expect(hueCollidesWithLive('#0a5')).toBe(false);
  });
});

describe('liveCollides / brandAccentCss', () => {
  it('only a custom color can collide', () => {
    expect(liveCollides({ accent: 'green' })).toBe(false);
    expect(liveCollides({ accent: 'blue' })).toBe(false);
    expect(liveCollides({ accent: 'custom', customHex: '#ee6a24' })).toBe(true);
    expect(liveCollides({ accent: 'custom', customHex: '#0f766e' })).toBe(false);
    expect(liveCollides(null)).toBe(false);
  });

  it('writes no live override for a green brand', () => {
    const css = brandAccentCss({ accent: 'green' });
    expect(css).toContain('--wk-brand:');
    expect(css).not.toContain('--wk-live');
  });

  it('writes the cobalt live family, light and dark, for an orange brand', () => {
    const css = brandAccentCss({ accent: 'custom', customHex: '#ee6a24', opacity: 100 });
    expect(css).toContain(`:root{--wk-brand:`);
    expect(css).toContain(`--wk-live:${LIVE_COBALT.light.live};`);
    expect(css).toContain(`--wk-live-ink:${LIVE_COBALT.light.ink};`);
    expect(css).toMatch(new RegExp(`\\[data-theme="dark"\\]\\{[^}]*--wk-live:${LIVE_COBALT.dark.live};`));
    // the dark rule comes after :root so it wins in dark mode
    expect(css.indexOf('[data-theme="dark"]')).toBeGreaterThan(css.indexOf(':root{'));
  });

  afterEach(() => { document.getElementById('nexus-brand-accent')?.remove(); });

  it('setBrandAccent puts the same text in one style element', () => {
    setBrandAccent({ accent: 'custom', customHex: '#c8323f' });
    setBrandAccent({ accent: 'custom', customHex: '#c8323f' });
    const els = document.querySelectorAll('#nexus-brand-accent');
    expect(els.length).toBe(1);
    expect(els[0].textContent).toBe(brandAccentCss({ accent: 'custom', customHex: '#c8323f' }));
  });
});
