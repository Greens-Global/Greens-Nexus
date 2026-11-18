import { describe, it, expect, vi, afterEach } from 'vitest';
import { setAppBadge, clearAppBadge, badgeSupported } from './appBadge';

// The count on the installed app's icon (the Badging API): the bell's Needs
// Action count goes on, 0 and sign out take it off, and a browser without the
// API - or one that refuses - is a quiet no-op.
const real = { set: navigator.setAppBadge, clear: navigator.clearAppBadge };
const install = (set, clear) => {
  if (set) navigator.setAppBadge = set; else delete navigator.setAppBadge;
  if (clear) navigator.clearAppBadge = clear; else delete navigator.clearAppBadge;
};
afterEach(() => install(real.set, real.clear));

describe('appBadge', () => {
  it('shows a positive count and clears at 0', () => {
    const set = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    install(set, clear);
    expect(badgeSupported()).toBe(true);
    setAppBadge(3);
    expect(set).toHaveBeenCalledWith(3);
    setAppBadge(0);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('clears for anything that is not a positive number, and floors a fraction', () => {
    const set = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    install(set, clear);
    [null, undefined, -2, NaN, 'x', 0.4].forEach((v) => setAppBadge(v));
    expect(clear).toHaveBeenCalledTimes(6);
    expect(set).not.toHaveBeenCalled();
    setAppBadge(2.9);
    expect(set).toHaveBeenCalledWith(2);
  });

  it('is a no-op where the browser has no Badging API', () => {
    install(null, null);
    expect(badgeSupported()).toBe(false);
    expect(() => { setAppBadge(5); setAppBadge(0); clearAppBadge(); }).not.toThrow();
  });

  it('falls back to setAppBadge(0) when only the setter exists', () => {
    const set = vi.fn(() => Promise.resolve());
    install(set, null);
    clearAppBadge();
    expect(set).toHaveBeenCalledWith(0);
  });

  it('never throws or leaves a rejection when the browser refuses', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      install(vi.fn(() => Promise.reject(new Error('NotAllowedError'))), vi.fn(() => { throw new Error('SecurityError'); }));
      expect(() => { setAppBadge(4); clearAppBadge(); }).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
});
