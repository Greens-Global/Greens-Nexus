import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDraft } from './useDraft';

// A save that landed for some keys and failed for others (Pay Rules): with
// `rebase`, the keys the person edited keep their edits when the saved value
// moves under them; without it, the draft starts over (a scope switch).
describe('useDraft', () => {
  it('starts over from a new saved value by default', () => {
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved), { initialProps: { saved: { a: 1, b: 1 } } });
    act(() => result.current.patch({ a: 2 }));
    expect(result.current.dirty).toBe(true);
    rerender({ saved: { a: 1, b: 5 } });
    expect(result.current.draft).toEqual({ a: 1, b: 5 });
    expect(result.current.dirty).toBe(false);
  });

  it('with rebase, keeps the edited keys and follows the rest', () => {
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved, { rebase: true }), { initialProps: { saved: { a: { n: 1 }, b: { n: 1 }, c: 1 } } });
    act(() => result.current.patch({ a: { n: 2 }, b: { n: 3 } }));
    // `a` saved (the server now holds 2); `b` failed (still 1); `c` moved elsewhere.
    rerender({ saved: { a: { n: 2 }, b: { n: 1 }, c: 9 } });
    expect(result.current.draft).toEqual({ a: { n: 2 }, b: { n: 3 }, c: 9 });
    expect(result.current.dirty).toBe(true);   // b is still unsaved
    act(() => result.current.reset());
    expect(result.current.draft).toEqual({ a: { n: 2 }, b: { n: 1 }, c: 9 });
    expect(result.current.dirty).toBe(false);
  });

  it('with rebase, a save that landed leaves the form clean: "10" typed, 10 back; values the server normalized', () => {
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved, { rebase: true }),
      { initialProps: { saved: { rounding: { nearestMin: 5 }, cc: 'a@x.com', mailbox: '', hours: 24 } } });
    act(() => result.current.patch({ rounding: { nearestMin: '10' }, cc: 'a@x.com,b@x.com', mailbox: 'Help@X.com', hours: '999' }));
    rerender({ saved: { rounding: { nearestMin: 10 }, cc: 'a@x.com, b@x.com', mailbox: 'help@x.com', hours: 720 } });
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft).toEqual({ rounding: { nearestMin: 10 }, cc: 'a@x.com, b@x.com', mailbox: 'help@x.com', hours: 720 });
  });

  it('settle adopts the server value for saved keys, but not one typed again while the save was in flight', () => {
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved, { rebase: true }),
      { initialProps: { saved: { a: 5, b: 5, c: 5 } } });
    act(() => result.current.patch({ a: '5 ', b: '7', c: '8' }));
    act(() => result.current.begin());
    act(() => result.current.patch({ b: '9' }));           // typed during the save
    // a and b saved (a normalized back to the same 5); c failed.
    rerender({ saved: { a: 5, b: 7, c: 5 } });
    act(() => result.current.settle(['a', 'b']));
    expect(result.current.draft).toEqual({ a: 5, b: '9', c: '8' });
    expect(result.current.dirty).toBe(true);
  });

  it('with rebase, an untouched field inside an edited object follows the server', () => {
    // Pay Rules: the switch saved (enabled + hasOverride come back), the
    // minutes typed beside it stay a draft.
    const { result, rerender } = renderHook(({ saved }) => useDraft(saved, { rebase: true }),
      { initialProps: { saved: { rounding: { enabled: false, nearestMin: 5, hasOverride: false } } } });
    act(() => result.current.patch({ rounding: { ...result.current.draft.rounding, nearestMin: 10, enabled: true } }));
    rerender({ saved: { rounding: { enabled: true, nearestMin: 5, hasOverride: true } } });
    expect(result.current.draft).toEqual({ rounding: { enabled: true, nearestMin: 10, hasOverride: true } });
    expect(result.current.dirty).toBe(true);
    // Only the switch was ever changed: after its save the draft is clean.
    const two = renderHook(({ saved }) => useDraft(saved, { rebase: true }),
      { initialProps: { saved: { r: { enabled: false, hasOverride: false } } } });
    act(() => two.result.current.patch({ r: { enabled: true, hasOverride: false } }));
    two.rerender({ saved: { r: { enabled: true, hasOverride: true } } });
    expect(two.result.current.dirty).toBe(false);
  });
});
