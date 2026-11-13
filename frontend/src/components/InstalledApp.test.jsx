import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

// The installed app (components/InstalledApp.jsx): the icon's count is the
// bell's Needs Action count, a shortcut launch runs the bolt's own action,
// and /?share=1 opens the Share to Nexus sheet with only the places this
// person may start something.

const lists = { current: { actionable: [], updates: [], unread: null } };
vi.mock('../lib/notificationCounts', () => ({ useBellLists: () => lists.current }));
const role = { current: null };
const employee = { myRole: 'employee', isExternal: false, can: (r) => r === 'employee', myGrantedModules: new Map([['tasks', 'editor']]), canAccessModule: () => true };
vi.mock('../contexts/RoleContext', async (orig) => ({ ...(await orig()), useRole: () => role.current }));
const share = vi.hoisted(() => ({ readShare: vi.fn(), clearShare: vi.fn(async () => {}), sweepShare: vi.fn(async () => {}) }));
vi.mock('../lib/shareTarget', async (orig) => ({ ...(await orig()), ...share }));

const { default: InstalledApp } = await import('./InstalledApp');
const { takeQuickAction } = await import('../lib/quickCreate');

const launch = (v) => sessionStorage.setItem('nx-app-launch', JSON.stringify({ ...v, at: Date.now() }));
const realBadge = { set: navigator.setAppBadge, clear: navigator.clearAppBadge };

beforeEach(() => {
  sessionStorage.clear();
  role.current = employee;
  lists.current = { actionable: [], updates: [], unread: null };
  Object.values(share).forEach((f) => f.mockClear());
  navigator.setAppBadge = vi.fn(() => Promise.resolve());
  navigator.clearAppBadge = vi.fn(() => Promise.resolve());
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  takeQuickAction();
  if (realBadge.set) navigator.setAppBadge = realBadge.set; else delete navigator.setAppBadge;
  if (realBadge.clear) navigator.clearAppBadge = realBadge.clear; else delete navigator.clearAppBadge;
});

describe('the app badge', () => {
  it('is left alone until the bell has loaded, then follows the Needs Action count', () => {
    const { rerender } = render(<InstalledApp />);
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
    expect(navigator.clearAppBadge).not.toHaveBeenCalled();
    lists.current = { actionable: [{ id: 'a' }, { id: 'b' }], updates: [{ id: 'u', read: false }], unread: 3 };
    rerender(<InstalledApp />);
    expect(navigator.setAppBadge).toHaveBeenLastCalledWith(2);   // Needs Action, not every unread notice
    lists.current = { actionable: [], updates: [], unread: 0 };
    rerender(<InstalledApp />);
    expect(navigator.clearAppBadge).toHaveBeenCalledTimes(1);
  });
});

describe('an app shortcut launch', () => {
  it('asks the bolt for that Quick Action, once, and draws nothing', () => {
    launch({ action: 'ticket', share: false });
    const { container } = render(<InstalledApp />);
    expect(container.innerHTML).toBe('');
    expect(takeQuickAction()).toEqual({ key: 'ticket', seed: null });
    expect(sessionStorage.getItem('nx-app-launch')).toBeNull();
  });

  it('with no launch it only sweeps an old share', () => {
    render(<InstalledApp />);
    expect(share.sweepShare).toHaveBeenCalledTimes(1);
    expect(takeQuickAction()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Share to Nexus', () => {
  const photo = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
  const shared = { at: Date.now(), title: '', text: 'Front gate keypad is dead', url: '', files: [photo], skipped: 0 };

  it('lists what was shared and offers New Ticket, New Task and New Note', async () => {
    share.readShare.mockResolvedValue(shared);
    launch({ action: '', share: true });
    render(<InstalledApp />);
    expect(await screen.findByRole('dialog', { name: 'Share to Nexus' })).toBeTruthy();
    expect(await screen.findByText('Front gate keypad is dead')).toBeTruthy();
    expect(screen.getByText('gate.jpg')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') || '').filter((t) => /^New /.test(t)).map((t) => t.split('.')[0]))
      .toEqual(['New Ticket', 'New Task', 'New Note']);
    // Said plainly: a note cannot take the file from here.
    expect(screen.getByText('Takes the text only. Open the note and add the file from your phone.')).toBeTruthy();
    expect(share.clearShare).not.toHaveBeenCalled();
  });

  it('picking a place hands the bolt that action with the words and files, and removes the share', async () => {
    share.readShare.mockResolvedValue(shared);
    launch({ action: '', share: true });
    render(<InstalledApp />);
    fireEvent.click(await screen.findByRole('button', { name: /New Ticket/ }));
    expect(takeQuickAction()).toEqual({ key: 'ticket', seed: { subject: 'Front gate keypad is dead', description: 'Front gate keypad is dead', files: [photo] } });
    expect(share.clearShare).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('only the places this person may use are offered', async () => {
    role.current = { ...employee, myGrantedModules: new Map() };   // no Tasks grant
    share.readShare.mockResolvedValue(shared);
    launch({ action: '', share: true });
    render(<InstalledApp />);
    await screen.findByText('gate.jpg');
    expect(screen.queryByRole('button', { name: /New Task/ })).toBeNull();
    expect(screen.getByRole('button', { name: /New Ticket/ })).toBeTruthy();
  });

  it('Not Now removes the share without starting anything', async () => {
    share.readShare.mockResolvedValue(shared);
    launch({ action: '', share: true });
    render(<InstalledApp />);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Not Now' })); });
    await waitFor(() => expect(share.clearShare).toHaveBeenCalledTimes(1));
    expect(takeQuickAction()).toBeNull();
  });

  it('when nothing came through it says so and still lets the person start', async () => {
    share.readShare.mockResolvedValue(null);
    launch({ action: '', share: true });
    render(<InstalledApp />);
    expect(await screen.findByText('Nothing Came Through')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Task/ }));
    expect(takeQuickAction()).toEqual({ key: 'task', seed: null });
  });
});
