import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const guard = vi.hoisted(() => ({ answer: true }));
vi.mock('../../lib/dialogGuard', async (orig) => ({
  ...(await orig()),
  askToLeave: vi.fn(() => Promise.resolve(guard.answer)),
}));

const { askToLeave, hasUnsavedWork, setInlineDirty } = await import('../../lib/dialogGuard');
const { default: usePopGuard } = await import('./usePopGuard');

function Host({ dirty }) {
  usePopGuard(dirty);
  return null;
}

// App's own popstate listener: registered without capture, like the real one.
let appHeard;
const onAppPop = () => { appHeard += 1; };

function popTo(path, depth) {
  window.history.replaceState({ depth }, '', path);
  act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: { depth } })); });
}

beforeEach(() => {
  appHeard = 0;
  guard.answer = true;
  askToLeave.mockClear();
  window.history.replaceState({ depth: 3 }, '', '/pdf-editor');
  window.history.go = vi.fn();
  window.addEventListener('popstate', onAppPop);
});

afterEach(() => {
  cleanup();
  window.removeEventListener('popstate', onAppPop);
  setInlineDirty('pdf-tools', false);
});

describe('Back and Forward with unsaved work', () => {
  it('leaves a clean editor alone', () => {
    render(<Host dirty={false} />);
    popTo('/tasks', 2);
    expect(appHeard).toBe(1);
    expect(askToLeave).not.toHaveBeenCalled();
    expect(window.history.go).not.toHaveBeenCalled();
  });

  it('holds Back: App never hears it, the address goes back, then it asks', async () => {
    guard.answer = false;
    render(<Host dirty />);
    popTo('/tasks', 2);
    expect(appHeard).toBe(0);
    expect(window.history.go).toHaveBeenCalledWith(1);
    expect(askToLeave).toHaveBeenCalledTimes(1);
  });

  it('swallows the restoring pop, so App does not take it for a move', () => {
    guard.answer = false;
    render(<Host dirty />);
    popTo('/tasks', 2);
    popTo('/pdf-editor', 3);
    expect(appHeard).toBe(0);
  });

  it('stays when they keep editing', async () => {
    guard.answer = false;
    setInlineDirty('pdf-tools', true);
    render(<Host dirty />);
    popTo('/tasks', 2);
    await act(async () => { await Promise.resolve(); });
    expect(window.history.go).toHaveBeenCalledTimes(1);
    expect(hasUnsavedWork()).toBe(true);
  });

  it('goes when they discard, and App then hears the real move', async () => {
    setInlineDirty('pdf-tools', true);
    render(<Host dirty />);
    popTo('/tasks', 2);
    popTo('/pdf-editor', 3);
    await act(async () => { await Promise.resolve(); });
    expect(window.history.go).toHaveBeenLastCalledWith(-1);
    expect(hasUnsavedWork()).toBe(false);
    popTo('/tasks', 2);
    expect(appHeard).toBe(1);
  });

  it('handles Forward the same way, by the depth it came from', () => {
    render(<Host dirty />);
    popTo('/tasks', 4);
    expect(window.history.go).toHaveBeenCalledWith(-1);
  });

  it('leaves a popup\'s own history entry on this path alone', () => {
    render(<Host dirty />);
    popTo('/pdf-editor', 2);
    expect(appHeard).toBe(1);
    expect(askToLeave).not.toHaveBeenCalled();
  });

  it('stops listening once the work is saved', () => {
    const { rerender } = render(<Host dirty />);
    rerender(<Host dirty={false} />);
    popTo('/tasks', 2);
    expect(appHeard).toBe(1);
    expect(askToLeave).not.toHaveBeenCalled();
  });
});
