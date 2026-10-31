import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Keyboard flow through the desk's list (Oct 31 2026): ↑ ↓ move a highlight,
// Enter opens the highlighted ticket, Escape clears the highlight. Keys typed
// into a field, or inside a dialog, are never the list's.

const { useListKeys } = await import('./useListKeys');

const key = (k, target = document.body) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('useListKeys', () => {
  it('moves the highlight with the arrow keys and stops at the ends', () => {
    const { result } = renderHook(() => useListKeys({ ids: ['a', 'b', 'c'], onOpen: vi.fn() }));
    expect(result.current.focusId).toBeNull();
    act(() => { key('ArrowDown'); });
    expect(result.current.focusId).toBe('a');
    act(() => { key('ArrowDown'); key('ArrowDown'); key('ArrowDown'); });
    expect(result.current.focusId).toBe('c');
    act(() => { key('ArrowUp'); });
    expect(result.current.focusId).toBe('b');
  });

  it('starts from the open ticket when there is one', () => {
    const { result } = renderHook(() => useListKeys({ ids: ['a', 'b', 'c'], onOpen: vi.fn(), openId: 'b' }));
    act(() => { key('ArrowDown'); });
    expect(result.current.focusId).toBe('c');
  });

  it('opens the highlighted ticket on Enter and clears on Escape', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useListKeys({ ids: ['a', 'b'], onOpen }));
    act(() => { key('Enter'); });
    expect(onOpen).not.toHaveBeenCalled();
    act(() => { key('ArrowDown'); key('Enter'); });
    expect(onOpen).toHaveBeenCalledWith('a');
    act(() => { key('Escape'); });
    expect(result.current.focusId).toBeNull();
  });

  it('tells the caller about every move', () => {
    const onMove = vi.fn();
    renderHook(() => useListKeys({ ids: ['a', 'b'], onOpen: vi.fn(), onMove }));
    act(() => { key('ArrowDown'); key('ArrowDown'); });
    expect(onMove.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('ignores keys typed in a field or inside a dialog', () => {
    document.body.innerHTML = '<input id="f" /><div role="dialog"><button id="d">x</button></div><div contenteditable="true" id="e"></div>';
    const { result } = renderHook(() => useListKeys({ ids: ['a', 'b'], onOpen: vi.fn() }));
    act(() => { key('ArrowDown', document.getElementById('f')); });
    act(() => { key('ArrowDown', document.getElementById('d')); });
    act(() => { key('ArrowDown', document.getElementById('e')); });
    expect(result.current.focusId).toBeNull();
  });

  it('listens inside a dialog when the caller owns it', () => {
    document.body.innerHTML = '<div role="dialog"><button id="d">x</button></div>';
    const { result } = renderHook(() => useListKeys({ ids: ['a', 'b'], onOpen: vi.fn(), ownsDialog: true }));
    act(() => { key('ArrowDown', document.getElementById('d')); });
    expect(result.current.focusId).toBe('a');
  });

  it('does nothing while disabled, and drops a highlight that left the list', () => {
    const { result, rerender } = renderHook(({ ids, enabled }) => useListKeys({ ids, enabled, onOpen: vi.fn() }),
      { initialProps: { ids: ['a', 'b'], enabled: false } });
    act(() => { key('ArrowDown'); });
    expect(result.current.focusId).toBeNull();
    rerender({ ids: ['a', 'b'], enabled: true });
    act(() => { key('ArrowDown'); key('ArrowDown'); });
    expect(result.current.focusId).toBe('b');
    rerender({ ids: ['a'], enabled: true });
    expect(result.current.focusId).toBeNull();
  });

  it('swallows the arrow key so the page does not scroll', () => {
    renderHook(() => useListKeys({ ids: ['a'], onOpen: vi.fn() }));
    let ev;
    act(() => { ev = key('ArrowDown'); });
    expect(ev.defaultPrevented).toBe(true);
  });
});
