import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useState } from 'react';

// Appearance follows the account (11/13/2026): Dark Mode and the Theme live
// in the person's profile prefs (table "appearance", `data`), this browser's
// copy paints first, and one pass settles the two when the account answers.
const server = vi.hoisted(() => ({ prefs: {}, fail: false, actAs: null }));
const apiSpies = vi.hoisted(() => ({}));
vi.mock('../api', () => {
  const handlers = {
    getTaskTablePrefs: vi.fn(() => (server.fail ? Promise.reject(new Error('offline')) : Promise.resolve({ prefs: server.prefs }))),
    saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
  };
  Object.assign(apiSpies, handlers);
  return { api: handlers, getActAsSessionId: () => server.actAs };
});

const { reconcileAppearance, cleanAppearance, useAccountAppearance, DEFAULTS } = await import('./appearancePrefs');
const { __setTablePrefsCache } = await import('../tasks/tableCols');

describe('reconcileAppearance', () => {
  const light = { mode: 'light', theme: 'cobalt' };

  it('the account has a value: it wins on this device, nothing is saved', () => {
    expect(reconcileAppearance({ local: light, account: { mode: 'dark', theme: 'warm' } }))
      .toEqual({ apply: { mode: 'dark', theme: 'warm' }, save: null });
    // Already the same: nothing to do.
    expect(reconcileAppearance({ local: { mode: 'dark', theme: 'warm' }, account: { mode: 'dark', theme: 'warm' } }))
      .toEqual({ apply: {}, save: null });
    // A device that had chosen Dark still follows an account that says Light.
    expect(reconcileAppearance({ local: { mode: 'dark', theme: 'cobalt' }, account: { mode: 'light' } }).apply).toEqual({ mode: 'light' });
  });

  it('the account has none: a look this device chose is lifted, the default is not', () => {
    expect(reconcileAppearance({ local: { mode: 'dark', theme: 'cobalt' }, account: {} }))
      .toEqual({ apply: {}, save: { mode: 'dark' } });
    // A new account on a device that never chose: today's default, and nothing written.
    expect(reconcileAppearance({ local: { ...DEFAULTS }, account: {} })).toEqual({ apply: {}, save: null });
    expect(reconcileAppearance({ local: light, account: undefined })).toEqual({ apply: {}, save: null });
  });

  it('each key settles on its own, and a lift keeps what the account already had', () => {
    expect(reconcileAppearance({ local: { mode: 'light', theme: 'warm' }, account: { mode: 'dark' } }))
      .toEqual({ apply: { mode: 'dark' }, save: { mode: 'dark', theme: 'warm' } });
  });

  it('a change made here before the account answered wins and is saved', () => {
    expect(reconcileAppearance({ local: { mode: 'light', theme: 'cobalt' }, account: { mode: 'dark' }, touched: { mode: true } }))
      .toEqual({ apply: {}, save: { mode: 'light' } });
  });

  it('an account that could not be asked changes nothing', () => {
    expect(reconcileAppearance({ local: light, account: { mode: 'dark' }, fromServer: false })).toEqual({ apply: {}, save: null });
  });

  it('unknown values are ignored on both sides', () => {
    expect(cleanAppearance({ mode: 'neon', theme: 'warm', extra: 1 })).toEqual({ theme: 'warm' });
    expect(reconcileAppearance({ local: light, account: { mode: 'neon' } })).toEqual({ apply: {}, save: null });
    expect(reconcileAppearance({ local: { mode: 'sepia', theme: 'cobalt' }, account: {} })).toEqual({ apply: {}, save: null });
  });
});

// The header's two looks, as App.jsx and TopHeader.jsx hold them.
let shell;
function Shell({ startTheme = 'light', startWk = 'cobalt' }) {
  const [theme, setTheme] = useState(startTheme);
  const [wkTheme, setWkTheme] = useState(startWk);
  useAccountAppearance({ theme, onThemeToggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), wkTheme, setWkTheme });
  shell = { theme, wkTheme, setTheme, setWkTheme };
  return null;
}
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

describe('useAccountAppearance', () => {
  beforeEach(() => {
    server.prefs = {}; server.fail = false; server.actAs = null;
    __setTablePrefsCache(null);
    apiSpies.getTaskTablePrefs.mockClear(); apiSpies.saveTaskTablePrefs.mockClear();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });
  afterEach(() => cleanup());

  it('a device on the default follows the account once it loads', async () => {
    server.prefs = { appearance: { data: { mode: 'dark', theme: 'warm' } } };
    render(<Shell />);
    expect(shell.theme).toBe('light');                    // first paint: this device's own copy
    await settle();
    expect(shell.theme).toBe('dark');
    expect(shell.wkTheme).toBe('warm');
    expect(apiSpies.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('a new account keeps the default and writes nothing', async () => {
    render(<Shell />);
    await settle();
    expect([shell.theme, shell.wkTheme]).toEqual(['light', 'cobalt']);
    expect(apiSpies.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('a device that already chose Dark gives it to an account with none', async () => {
    render(<Shell startTheme="dark" />);
    await settle();
    expect(shell.theme).toBe('dark');
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenCalledTimes(1);
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenCalledWith('appearance', { data: { mode: 'dark' } });
  });

  it('a change on this device is written to the account - only the key that changed', async () => {
    server.prefs = { appearance: { data: { mode: 'dark' } } };
    render(<Shell startTheme="dark" />);
    await settle();
    act(() => shell.setWkTheme('warm'));
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenLastCalledWith('appearance', { data: { mode: 'dark', theme: 'warm' } });
    act(() => shell.setTheme('light'));
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenLastCalledWith('appearance', { data: { mode: 'light', theme: 'warm' } });
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenCalledTimes(2);
  });

  it('switching the Theme on a new account never stamps this device\'s Dark Mode on it', async () => {
    render(<Shell />);
    await settle();
    act(() => shell.setWkTheme('warm'));
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenLastCalledWith('appearance', { data: { theme: 'warm' } });
  });

  it('a toggle made before the account answered is kept and saved', async () => {
    server.prefs = { appearance: { data: { mode: 'light' } } };
    render(<Shell />);
    act(() => shell.setTheme('dark'));                    // the person was faster than the fetch
    await settle();
    expect(shell.theme).toBe('dark');
    expect(apiSpies.saveTaskTablePrefs).toHaveBeenLastCalledWith('appearance', { data: { mode: 'dark' } });
  });

  it('offline: the device keeps its own look and nothing is written', async () => {
    server.fail = true;
    localStorage.setItem('nexus.taskTablePrefs', JSON.stringify({ appearance: { data: { mode: 'dark' } } }));   // someone's cached copy
    render(<Shell />);
    await settle();
    expect(shell.theme).toBe('light');
    act(() => shell.setTheme('dark'));
    expect(apiSpies.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('acting as someone else: their look is not applied and nothing is written to them', async () => {
    server.actAs = 'sess-1';
    server.prefs = { appearance: { data: { mode: 'dark', theme: 'warm' } } };
    render(<Shell />);
    await settle();
    expect([shell.theme, shell.wkTheme]).toEqual(['light', 'cobalt']);
    act(() => shell.setTheme('dark'));
    expect(apiSpies.saveTaskTablePrefs).not.toHaveBeenCalled();
  });
});
