import { describe, it, expect, afterEach } from 'vitest';
import { canRecordScreen } from './screenCapability';

const realMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const setMedia = (v) => Object.defineProperty(navigator, 'mediaDevices', { value: v, configurable: true });

afterEach(() => {
  if (realMedia) Object.defineProperty(navigator, 'mediaDevices', realMedia);
  else delete navigator.mediaDevices;
});

describe('canRecordScreen', () => {
  it('is false on a phone, even when the API exists', () => {
    setMedia({ getDisplayMedia: () => {} });
    expect(canRecordScreen(true)).toBe(false);
  });
  it('is true on a desktop browser with getDisplayMedia', () => {
    setMedia({ getDisplayMedia: () => {} });
    expect(canRecordScreen(false)).toBe(true);
  });
  it('is false where the browser has no getDisplayMedia', () => {
    setMedia({});
    expect(canRecordScreen(false)).toBe(false);
    setMedia(undefined);
    expect(canRecordScreen(false)).toBe(false);
  });
  it('reads the phone breakpoint itself when not told', () => {
    setMedia({ getDisplayMedia: () => {} });
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 640px'), media: q, addEventListener() {}, removeEventListener() {} });
    try { expect(canRecordScreen()).toBe(false); } finally { window.matchMedia = real; }
  });
});
