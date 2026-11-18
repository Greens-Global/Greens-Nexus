import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// A start asked for from outside the menu - an installed-app shortcut
// (/?do=new-task) or Share to Nexus: the bolt runs the same action it runs
// on a tap, with what the form starts with; an action this person does not
// have is dropped.

const seen = [];
vi.mock('../dashboard/QuickActionModals.jsx', () => ({
  default: ({ kind, seed }) => { seen.push({ kind, seed }); return <div role="dialog" aria-label={`Composer ${kind}`} />; },
}));
const role = { current: null };
const withTasks = { myRole: 'employee', isExternal: false, can: (r) => r === 'employee', myGrantedModules: new Map([['tasks', 'editor']]), canAccessModule: () => true };
vi.mock('../contexts/RoleContext', async (orig) => ({ ...(await orig()), useRole: () => role.current }));

const { default: QuickCreate } = await import('./QuickCreate');
const { runQuickAction, takeQuickAction, visibleActions } = await import('../lib/quickCreate');

afterEach(() => { cleanup(); seen.length = 0; takeQuickAction(); });

describe('a Quick Action started from outside the menu', () => {
  it('opens the same composer, with the seed, when asked while the bolt is on screen', async () => {
    role.current = withTasks;
    render(<QuickCreate />);
    const seed = { title: 'Gate', description: '', files: [] };
    act(() => runQuickAction('task', seed));
    expect(await screen.findByRole('dialog', { name: 'Composer task' })).toBeTruthy();
    expect(seen.at(-1)).toEqual({ kind: 'task', seed });
  });

  it('asked before the bolt mounted (app launch), it is taken on mount - once', async () => {
    role.current = withTasks;
    runQuickAction('task');
    render(<QuickCreate />);
    expect(await screen.findByRole('dialog', { name: 'Composer task' })).toBeTruthy();
    expect(seen.at(-1)).toEqual({ kind: 'task', seed: null });
    expect(takeQuickAction()).toBeNull();
  });

  it('New Note opens the Quick Note with the words', () => {
    role.current = withTasks;
    const heard = vi.fn();
    window.addEventListener('nexus:quick-note', heard);
    try {
      render(<QuickCreate />);
      act(() => runQuickAction('note', { html: '<p>Hi</p>' }));
      expect(heard.mock.calls[0][0].detail).toEqual({ seed: '<p>Hi</p>' });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally { window.removeEventListener('nexus:quick-note', heard); }
  });

  it('an action this person cannot use is dropped: nothing opens, nothing is left waiting', () => {
    // Tasks is grant-driven: without the grant the bolt has no New Task.
    role.current = { ...withTasks, myGrantedModules: new Map() };
    expect(visibleActions(role.current).some((it) => it.key === 'task')).toBe(false);
    runQuickAction('task');
    render(<QuickCreate />);
    act(() => runQuickAction('nonsense'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(takeQuickAction()).toBeNull();
  });

  it('a start nobody took within half a minute is not run later', () => {
    vi.useFakeTimers();
    try {
      runQuickAction('task');
      vi.advanceTimersByTime(31000);
      expect(takeQuickAction()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
