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

  it('does nothing when motion is off', () => {
    setMotionEnabled(false);
    const { rerender } = render(<ChangeFlash value="a" />);
    rerender(<ChangeFlash value="b" />);
    expect(glow()).toBeNull();
  });
});
