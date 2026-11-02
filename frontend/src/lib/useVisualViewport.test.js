// The visible box while a keyboard is up (Neil, Oct 30 2026): on an iPhone
// the keyboard's ^ v Done strip floats over the page, so the box says how
// much room it takes (`clear`) and what is pinned to the keyboard (the
// Notes bar, a sheet's panel) sits above it; backdrops keep the full height.
// No keyboard, a pinch zoom, an iPad, a landscape phone or not iOS: 0.
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readVisualViewport, useKeyboardInset, IOS_ACCESSORY_PX } from './useVisualViewport';

const realVV = window.visualViewport;
const realUA = navigator.userAgent;
const setUA = (ua) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
const setVV = (v) => Object.defineProperty(window, 'visualViewport', { value: { offsetTop: 0, offsetLeft: 0, width: 390, scale: 1, addEventListener() {}, removeEventListener() {}, ...v }, configurable: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { value: realVV, configurable: true });
  setUA(realUA);
  window.innerHeight = 768;
});

describe('readVisualViewport', () => {
  it('reports the iPhone keyboard strip while the keyboard is up, keeping the full height', () => {
    setUA(IPHONE); window.innerHeight = 844; setVV({ height: 500 });
    expect(readVisualViewport()).toMatchObject({ height: 500, clear: IOS_ACCESSORY_PX });
  });
  it('gives an iPad and a landscape iPhone no strip', () => {
    setUA('Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1');
    window.innerHeight = 1180; setVV({ height: 700, width: 820 });
    expect(readVisualViewport().clear).toBe(0);
    setUA(IPHONE); window.innerHeight = 390; setVV({ height: 150, width: 844 });
    expect(readVisualViewport().clear).toBe(0);
  });
  it('is the plain visible box with no keyboard, on a pinch zoom, or off iOS', () => {
    setUA(IPHONE); window.innerHeight = 844;
    setVV({ height: 844 });
    expect(readVisualViewport().clear).toBe(0);
    setVV({ height: 400, scale: 2 });
    expect(readVisualViewport().clear).toBe(0);
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36');
    setVV({ height: 500 });
    expect(readVisualViewport().clear).toBe(0);
  });
});

describe('useKeyboardInset', () => {
  it('lifts a bar over the keyboard and the strip, and is 0 with no keyboard', () => {
    setUA(IPHONE); window.innerHeight = 844;
    setVV({ height: 500, offsetTop: 0 });
    expect(renderHook(() => useKeyboardInset(true)).result.current).toBe(844 - 500 + IOS_ACCESSORY_PX);
    setVV({ height: 844 });
    expect(renderHook(() => useKeyboardInset(true)).result.current).toBe(0);
    expect(renderHook(() => useKeyboardInset(false)).result.current).toBe(0);
  });
});
