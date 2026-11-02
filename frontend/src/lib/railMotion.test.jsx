import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// The left navigation's motion strength (Neil, 11/01/2026): a person's
// choice beats the company default, reduced motion beats both, and the
// result is written to <html> for the stylesheet.

const mockApi = vi.hoisted(() => ({
  getBrandingConfig: vi.fn(() => Promise.resolve({ accent: 'green', navMotion: 'subtle' })),
  getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })),
  saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../api', () => ({ api: mockApi }));

let REDUCED = false;
const realMatchMedia = window.matchMedia;
const mqListeners = new Set();
beforeEach(() => {
  window.matchMedia = (q) => ({
    get matches() { return /prefers-reduced-motion/.test(q) ? REDUCED : false; },
    media: q, onchange: null,
    addEventListener: (_, fn) => mqListeners.add(fn), removeEventListener: (_, fn) => mqListeners.delete(fn),
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; REDUCED = false; mqListeners.clear(); delete document.documentElement.dataset.railMotion; document.documentElement.style.removeProperty('--rail-lift'); });

const { resolveStrength, applyRailMotion, useRailMotion, __resetRailMotion, LIFT, EVENT } = await import('./railMotion');
const { __setTablePrefsCache } = await import('../tasks/tableCols');

describe('resolveStrength', () => {
  it('a personal choice beats the company, which beats the Lively default', () => {
    expect(resolveStrength({})).toBe('lively');
    expect(resolveStrength({ company: 'subtle' })).toBe('subtle');
    expect(resolveStrength({ personal: 'bold', company: 'subtle' })).toBe('bold');
    expect(resolveStrength({ personal: 'default', company: 'off' })).toBe('off');
    expect(resolveStrength({ personal: 'huge', company: 'nonsense' })).toBe('lively');
  });
  it('reduced motion is Off whatever was chosen', () => {
    expect(resolveStrength({ personal: 'bold', company: 'bold', reduced: true })).toBe('off');
  });
});

describe('applyRailMotion', () => {
  it('writes the attribute and the lift; Off clears the lift', () => {
    applyRailMotion('lively');
    expect(document.documentElement.dataset.railMotion).toBe('lively');
    expect(document.documentElement.style.getPropertyValue('--rail-lift')).toBe(String(LIFT.lively));
    applyRailMotion('off');
    expect(document.documentElement.dataset.railMotion).toBe('off');
    expect(document.documentElement.style.getPropertyValue('--rail-lift')).toBe('');
  });
});

function Probe() {
  const m = useRailMotion();
  return <div data-testid="p" data-eff={m.effective} data-personal={m.personal} data-company={m.company} onClick={() => m.setPersonal('bold')} />;
}

describe('useRailMotion', () => {
  beforeEach(() => { __resetRailMotion(); __setTablePrefsCache({}); mockApi.getBrandingConfig.mockClear(); });

  it('follows the company default until the person chooses, then their choice', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('subtle'));
    expect(document.documentElement.dataset.railMotion).toBe('subtle');
    expect(getByTestId('p').dataset.personal).toBe('default');
    act(() => { getByTestId('p').click(); });
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('bold'));
    expect(mockApi.saveTaskTablePrefs).toHaveBeenCalledWith('nav', { motion: 'bold' });
    expect(document.documentElement.style.getPropertyValue('--rail-lift')).toBe(String(LIFT.bold));
  });

  it('a Settings save reaches an open sidebar through the nexus:rail-motion event', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('subtle'));
    act(() => { window.dispatchEvent(new CustomEvent(EVENT, { detail: { navMotion: 'off' } })); });
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('off'));
    expect(getByTestId('p').dataset.company).toBe('off');
  });

  it('reduced motion turns it off, even over a personal Bold, and reactively', async () => {
    __setTablePrefsCache({ nav: { motion: 'bold' } });
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('bold'));
    REDUCED = true;
    act(() => { mqListeners.forEach((fn) => fn()); });
    await waitFor(() => expect(getByTestId('p').dataset.eff).toBe('off'));
    expect(document.documentElement.dataset.railMotion).toBe('off');
  });
});
