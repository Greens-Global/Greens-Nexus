import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ?profile=security (Neil, 11/02/2026): the new sign-in bell and its email
// land on Profile > Security. Read at module load like ?emailSettings=1 (the
// app's boot rewrites the address before the header mounts), taken once and
// dropped from the URL. A bell click is a nexus:navigate with view 'profile'.
window.history.replaceState({}, '', '/dashboard?profile=security&x=1');

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pat Lee', username: 'pat@greensglobal.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('../support/HelpMenu', () => ({ default: () => null }));
vi.mock('./MyProfileModal', () => ({
  default: ({ initialSection, focusEmail }) => <div>profile:{initialSection || (focusEmail ? 'email' : 'default')}</div>,
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useRole: () => ({ myRole: 'employee', isExternal: false, can: () => false, myGrantedModules: new Map(), actingAs: null, stopActAs: vi.fn() }),
  };
});

const TopHeader = (await import('./TopHeader')).default;
const header = () => render(<TopHeader title="Tasks" activeView="tasks" theme="light" onThemeToggle={() => {}} onNavigate={() => {}} />);

describe('TopHeader - Profile deep links (11/02/2026)', () => {
  it('opens Profile on Security from ?profile=security and drops the parameter, keeping the rest of the URL', () => {
    header();
    expect(screen.getByText('profile:security')).toBeTruthy();
    expect(window.location.search).toBe('?x=1');
    expect(window.location.pathname).toBe('/dashboard');
  });

  it("a bell's { view: 'profile', sub: 'security' } opens the same section", () => {
    header();
    act(() => { window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'profile', sub: 'security' } })); });
    expect(screen.getAllByText('profile:security').length).toBeGreaterThan(0);
  });
});
