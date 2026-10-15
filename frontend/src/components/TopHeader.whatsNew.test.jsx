import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// What's New is a page in the app now, not an overlay over it, and the profile
// dropdown's "Help with this page" is gone - the header's Help panel has
// "Help with This Page" (Neil, Oct 12 2026; wording Oct 13).

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pat Lee', username: 'pat@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('../support/HelpMenu', () => ({ default: () => null }));
vi.mock('./MyProfileModal', () => ({ default: () => null }));
vi.mock('./EmailSettingsModal', () => ({ default: () => null }));
const markSeen = vi.fn(() => Promise.resolve({}));
const unseen = { value: false };
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => (k === 'markTaskChangelogSeen' ? markSeen
      : k === 'getTaskChangelogUnseen' ? () => Promise.resolve({ unseen: unseen.value })
        : () => Promise.resolve({})),
  }),
}));
const roleState = { isExternal: false, grants: new Map() };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({
      myRole: 'employee', isExternal: roleState.isExternal, can: () => false,
      myGrantedModules: roleState.grants, actingAs: null, stopActAs: vi.fn(),
    }),
  };
});

const TopHeader = (await import('./TopHeader')).default;
const header = (props = {}) => render(
  <TopHeader title="Tasks" activeView="tasks" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} {...props} />,
);
const openMenu = () => fireEvent.click(document.querySelector('.header-user-pill'));

beforeEach(() => { markSeen.mockClear(); unseen.value = false; roleState.isExternal = false; roleState.grants = new Map(); });

describe("TopHeader - What's New and page help", () => {
  it("What's New navigates to its page; there is no page-help row", () => {
    const onNavigate = vi.fn();
    header({ onNavigate });
    openMenu();
    expect(screen.queryByText(/Help with this page/i)).toBeNull();
    fireEvent.click(screen.getByText("What's New"));
    expect(onNavigate).toHaveBeenCalledWith('whats-new');
  });

  it('landing on the page records the visit; there is no eye icon to clear', async () => {
    // The red-dot eye beside the profile pill is gone (Neil, Oct 14 2026) - the
    // announcement bar and the bell already say there is news. The visit is
    // still recorded: the weekly bar and the bell's read state go by it.
    unseen.value = true;
    const { rerender } = header();
    await act(async () => {});
    expect(screen.queryByLabelText('New update published')).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();
    rerender(<TopHeader title="What's New" activeView="whats-new" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
  });

  it('is offered to every signed-in user - reading it needs no grant, externals included', () => {
    roleState.isExternal = true;               // no grants at all
    header();
    openMenu();
    expect(screen.getByText("What's New")).toBeTruthy();
  });
});
