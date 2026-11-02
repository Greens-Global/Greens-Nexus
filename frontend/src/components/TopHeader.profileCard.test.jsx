import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The profile pill and its dropdown card (Neil, 11/02/2026): the job title
// under the name, the tier only as the small mark after the name. The Shield
// badge row that spelled out the tier ("Global Admin") is gone, and the card's
// avatar no longer takes the tier's color.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Charmi Shah', username: 'charmi@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('../support/HelpMenu', () => ({ default: () => null }));
vi.mock('./MyProfileModal', () => ({ default: () => null }));
vi.mock('./QuickCreate', () => ({ default: () => null }));
vi.mock('../notes/QuickNoteButton', () => ({ default: () => null }));
vi.mock('./ToolsMenu', () => ({ ToolsSection: () => null, ActAsFinder: () => null }));
const hrProfile = vi.fn(() => Promise.resolve({ jobTitle: 'FROM HR PROFILE' }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => (k === 'myHrProfile' ? hrProfile : k === 'qaEnabled' ? () => Promise.resolve({ enabled: false }) : () => Promise.resolve({})),
  }),
}));
const roleState = { myRole: 'administrator', myTier: 'admin', myTitle: 'Controller' };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({
      myRole: roleState.myRole, myTier: roleState.myTier, myTitle: roleState.myTitle, isExternal: false, can: () => false,
      myGrantedModules: new Map(), actingAs: null, stopActAs: vi.fn(), myEmail: 'charmi@greensglobal.com',
    }),
  };
});

const TopHeader = (await import('./TopHeader')).default;
const header = () => render(<TopHeader title="Tasks" activeView="tasks" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} />);
const openMenu = () => fireEvent.click(document.querySelector('.header-user-pill'));

afterEach(cleanup);

describe('TopHeader - profile pill and card', () => {
  it('the pill and the card say the job title; the tier is a mark, not a badge row', () => {
    Object.assign(roleState, { myRole: 'administrator', myTier: 'admin', myTitle: 'Controller' });
    header();
    expect(document.querySelector('.header-user-role').textContent).toBe('Controller');
    openMenu();
    const card = document.querySelector('.header-user-dropdown');
    expect(card.textContent).toContain('Charmi Shah');
    expect(card.textContent).toContain('Controller');
    expect(screen.queryByText('Administrator')).toBeNull();          // no badge row
    expect(card.querySelector('[aria-label="Administrator"]')).toBeTruthy();   // the mark after the name
    // The title comes from the one /roles/me answer, not a second HR call.
    expect(hrProfile).not.toHaveBeenCalled();
  });

  it('the card avatar is a neutral tint, not the tier color', () => {
    header();
    openMenu();
    const avatars = [...document.querySelectorAll('.header-user-dropdown div')].filter((d) => /border-radius: 50%/.test(d.getAttribute('style') || ''));
    expect(avatars.length).toBeGreaterThan(0);
    for (const a of avatars) expect(a.getAttribute('style')).not.toMatch(/--color-(purple|gold|orange|green|blue)/);
  });

  it('no job title: the pill subtitle is blank, never "Employee"', () => {
    Object.assign(roleState, { myRole: 'employee', myTier: '', myTitle: '' });
    header();
    expect(screen.queryByText('Employee')).toBeNull();
    expect((document.querySelector('.header-user-role')?.textContent || '')).toBe('');
    openMenu();
    expect(screen.queryByText('Employee')).toBeNull();
    expect(document.querySelector('.header-user-dropdown [data-tier]')).toBeNull();
  });
});
