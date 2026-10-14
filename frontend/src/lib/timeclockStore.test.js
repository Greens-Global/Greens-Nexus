import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { publishTimeclock, useTimeclock, claimTimeclockSurface, useTimeclockClaimed, timeclockSurfaceClaimed, fmtHM } from './timeclockStore';

// The engine publishes, the surfaces subscribe; a publish that changes
// nothing a surface draws is dropped (the engine renders every second and
// its action closures are new each time - that used to re-render every
// surface, and the engine itself, in a loop).

describe('timeclockStore', () => {
  it('delivers a changed view-model and drops an identical one', () => {
    const { result } = renderHook(() => useTimeclock());
    let renders = 0;
    const { result: counter } = renderHook(() => { renders += 1; return useTimeclock(); });
    const vm = { state: 'in', timer: '1:00', actions: { punchOut: () => {} } };
    act(() => publishTimeclock(vm));
    expect(result.current.timer).toBe('1:00');
    const after = renders;
    act(() => publishTimeclock({ ...vm, actions: { punchOut: () => {} } }));   // same picture, new closures
    expect(renders).toBe(after);
    act(() => publishTimeclock({ ...vm, timer: '1:01' }));
    expect(counter.current.timer).toBe('1:01');
    expect(renders).toBe(after + 1);
  });

  it('claims are counted and reach only the claim hook', () => {
    const { result } = renderHook(() => useTimeclockClaimed());
    expect(result.current).toBe(false);
    let release;
    act(() => { release = claimTimeclockSurface(); });
    expect(result.current).toBe(true);
    expect(timeclockSurfaceClaimed()).toBe(true);
    act(() => release());
    expect(result.current).toBe(false);
  });

  it('formats minutes as H:MM with no seconds', () => {
    expect(fmtHM(130)).toBe('2:10');
    expect(fmtHM(5)).toBe('0:05');
    expect(fmtHM(0)).toBe('0:00');
  });
});
