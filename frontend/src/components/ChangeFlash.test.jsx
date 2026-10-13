import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import ChangeFlash from './ChangeFlash';
import { setMotionEnabled } from '../lib/motion';

beforeEach(() => { vi.useFakeTimers(); setMotionEnabled(true); });
afterEach(() => { cleanup(); setMotionEnabled(false); vi.useRealTimers(); });

const glow = () => document.querySelector('.nx-flash');

describe('ChangeFlash', () => {
  it('is silent on mount, glows in the given color on a change, then clears', () => {
    const { rerender } = render(<ChangeFlash value="todo" color="#0a0" />);
    expect(glow()).toBeNull();
    rerender(<ChangeFlash value="done" color="#0a0" />);
    expect(glow()).not.toBeNull();
    expect(glow().style.getPropertyValue('--flash')).toBe('#0a0');
    act(() => { vi.advanceTimersByTime(900); });
    expect(glow()).toBeNull();
  });

  it('restarts for a second change inside the first glow', () => {
    const { rerender } = render(<ChangeFlash value="a" />);
    rerender(<ChangeFlash value="b" />);
    const first = glow();
    act(() => { vi.advanceTimersByTime(400); });
    rerender(<ChangeFlash value="c" />);
    expect(glow()).not.toBe(first);
    act(() => { vi.advanceTimersByTime(899); });
    expect(glow()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(glow()).toBeNull();
  });

  it('glows on mount when isFresh says the item just changed (a card that moved column)', () => {
    render(<ChangeFlash value="done" isFresh={() => true} />);
    expect(glow()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(900); });
    expect(glow()).toBeNull();
  });

  it('stays silent on mount when isFresh says no', () => {
    render(<ChangeFlash value="done" isFresh={() => false} />);
    expect(glow()).toBeNull();
  });

  it('does not glow on a fresh mount under reduced motion', () => {
    const mm = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      render(<ChangeFlash value="done" isFresh={() => true} />);
      expect(glow()).toBeNull();
    } finally { window.matchMedia = mm; }
  });

  it('does nothing when motion is off', () => {
    setMotionEnabled(false);
    const { rerender } = render(<ChangeFlash value="a" />);
    rerender(<ChangeFlash value="b" />);
    expect(glow()).toBeNull();
  });
});
