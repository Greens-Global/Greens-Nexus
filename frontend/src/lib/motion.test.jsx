import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePresence, useExit, setMotionEnabled, motionWait } from './motion';

// Under MODE=test motion is off by default (see motion.js). These tests turn
// it on to check the timed path, then put it back.
beforeEach(() => { vi.useFakeTimers(); setMotionEnabled(true); });
afterEach(() => { setMotionEnabled(false); vi.useRealTimers(); });

describe('usePresence', () => {
  it('mounts on open, stays mounted as closing, unmounts after the wait', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 100), { initialProps: { open: false } });
    expect(result.current).toEqual({ mounted: false, closing: false });
    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, closing: false });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, closing: true });
    act(() => { vi.advanceTimersByTime(99); });
    expect(result.current.mounted).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toEqual({ mounted: false, closing: false });
  });

  it('reopening during the exit cancels it', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 100), { initialProps: { open: true } });
    rerender({ open: false });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ open: true });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toEqual({ mounted: true, closing: false });
  });

  it('with motion off it unmounts on the same render', () => {
    setMotionEnabled(false);
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 100), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: false, closing: false });
  });
});

describe('useExit', () => {
  it('flags closing, then calls onClose once after the wait', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useExit(onClose, 100));
    expect(result.current[0]).toBe(false);
    act(() => { result.current[1]('why'); });
    expect(result.current[0]).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { result.current[1](); });            // a second click is ignored
    act(() => { vi.advanceTimersByTime(100); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('why');
  });

  it('uses the latest onClose and clears the timer on unmount', () => {
    const first = vi.fn(); const second = vi.fn();
    const { result, rerender, unmount } = renderHook(({ fn }) => useExit(fn, 100), { initialProps: { fn: first } });
    rerender({ fn: second });
    act(() => { result.current[1](); });
    unmount();
    act(() => { vi.advanceTimersByTime(200); });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('with motion off it calls onClose immediately', () => {
    setMotionEnabled(false);
    const onClose = vi.fn();
    const { result } = renderHook(() => useExit(onClose, 100));
    act(() => { result.current[1](); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toBe(false);
    expect(motionWait(100)).toBe(0);
  });
});

describe('useExit after unmount', () => {
  it('ignores a close that arrives once the surface is gone', () => {
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useExit(onClose, 100));
    const request = result.current[1];
    unmount();
    act(() => { request(); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(onClose).not.toHaveBeenCalled();
  });
});
