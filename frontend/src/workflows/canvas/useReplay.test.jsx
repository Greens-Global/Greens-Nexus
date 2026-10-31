// useReplay (10/30/2026): the connector marches, then the node lights; a
// waiting node breathes first; a failed node ends the story; the picture
// holds and clears; reduced motion lands everything at once.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EDGE_MS, HOLD_MS, NODE_MS, WAIT_MS, useReplay } from './useReplay';

afterEach(() => { vi.useRealTimers(); });

const plan = (statusById) => ({ order: Object.keys(statusById), statusById, note: '' });
const tick = (ms) => act(() => { vi.advanceTimersByTime(ms); });

describe('useReplay', () => {
  it('lights node by node with the connector marching in between, then holds and clears', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const replay = plan({ trigger: 'done', a1: 'done', a2: 'done' });
    const { result } = renderHook(() => useReplay(replay, { onDone }));
    expect(result.current.active).toBe(false);          // the first frame lands on the next tick
    tick(0);
    expect(result.current.active).toBe(true);
    expect(result.current.nodeClass('trigger')).toBe('wfc-lit');
    expect(result.current.nodeClass('a1')).toBe('');
    tick(NODE_MS);
    expect(result.current.edgeClass('e1', 'trigger', 'a1')).toBe('wfc-live');
    tick(EDGE_MS);
    expect(result.current.edgeClass('e1', 'trigger', 'a1')).toBe('wfc-hot');
    expect(result.current.nodeClass('a1')).toBe('wfc-lit');
    tick(NODE_MS + EDGE_MS);
    expect(result.current.nodeClass('a2')).toBe('wfc-lit');
    expect(onDone).not.toHaveBeenCalled();
    tick(HOLD_MS);
    expect(onDone).toHaveBeenCalledWith({ stoppedAt: 'a2', failed: false });
    expect(result.current.active).toBe(false);
    expect(result.current.nodeClass('a2')).toBe('');
  });

  it('breathes on a waiting node before moving on, and stops red on a failed one', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const replay = plan({ trigger: 'done', w1: 'waiting', a3: 'failed', a4: 'done' });
    const { result } = renderHook(() => useReplay(replay, { onDone }));
    tick(0);
    tick(NODE_MS + EDGE_MS);
    expect(result.current.nodeClass('w1')).toBe('wfc-waitlit');
    tick(WAIT_MS);
    expect(result.current.nodeClass('w1')).toBe('wfc-lit');
    tick(EDGE_MS);
    expect(result.current.nodeClass('a3')).toBe('wfc-failed');
    tick(EDGE_MS + NODE_MS);
    expect(result.current.nodeClass('a4')).toBe('');          // nothing after the failure lights
    tick(HOLD_MS);
    expect(onDone).toHaveBeenCalledWith({ stoppedAt: 'a3', failed: true });
  });

  it('passes over a node the run has no row for without lighting it, like the reduced-motion picture', () => {
    vi.useFakeTimers();
    const replay = { order: ['trigger', 'a1', 'p1', 'a2'], statusById: { trigger: 'done', a1: 'done', a2: 'done' }, note: '' };
    const { result } = renderHook(() => useReplay(replay));
    tick(0);
    tick(NODE_MS + EDGE_MS);          // a1 lit
    expect(result.current.nodeClass('a1')).toBe('wfc-lit');
    tick(NODE_MS + EDGE_MS);          // p1 reached: passed over, its connector still turns hot
    expect(result.current.nodeClass('p1')).toBe('');
    expect(result.current.edgeClass('e', 'a1', 'p1')).toBe('wfc-hot');
    tick(EDGE_MS);
    expect(result.current.nodeClass('a2')).toBe('wfc-lit');
    const still = renderHook(() => useReplay(replay, { reduced: true }));
    expect(still.result.current.nodeClass('p1')).toBe('');
    expect(still.result.current.nodeClass('a2')).toBe('wfc-lit');
  });

  it('keeps a last waiting node amber until the hold ends', () => {
    vi.useFakeTimers();
    const replay = plan({ trigger: 'done', ap: 'waiting' });
    const { result } = renderHook(() => useReplay(replay));
    tick(0);
    tick(NODE_MS + EDGE_MS);
    expect(result.current.nodeClass('ap')).toBe('wfc-waitlit');
    tick(WAIT_MS);
    expect(result.current.nodeClass('ap')).toBe('wfc-waitlit');
  });

  it('lands everything at once under reduced motion and leaves it until stop()', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const replay = plan({ trigger: 'done', a1: 'waiting', a2: 'failed' });
    const { result } = renderHook(() => useReplay(replay, { onDone, reduced: true }));
    expect(result.current.active).toBe(true);
    expect(result.current.nodeClass('trigger')).toBe('wfc-lit');
    expect(result.current.nodeClass('a1')).toBe('wfc-waitlit');
    expect(result.current.nodeClass('a2')).toBe('wfc-failed');
    expect(result.current.edgeClass('e', 'a1', 'a2')).toBe('wfc-hot');
    tick(HOLD_MS * 3);
    expect(result.current.active).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    act(() => { result.current.stop(); });
    expect(result.current.active).toBe(false);
    expect(result.current.nodeClass('trigger')).toBe('');
  });

  it('does nothing without a plan, starts a new plan from nothing, and clears its timer on unmount', () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ r }) => useReplay(r), { initialProps: { r: null } });
    expect(result.current.active).toBe(false);
    const first = plan({ trigger: 'done', a1: 'done' });
    rerender({ r: first });
    tick(NODE_MS + EDGE_MS);
    expect(result.current.nodeClass('a1')).toBe('wfc-lit');
    rerender({ r: plan({ trigger: 'done', b1: 'done' }) });
    expect(result.current.nodeClass('a1')).toBe('');         // the old picture is gone at once
    tick(0);
    expect(result.current.nodeClass('trigger')).toBe('wfc-lit');
    unmount();
    expect(() => vi.advanceTimersByTime(HOLD_MS * 2)).not.toThrow();
  });
});
