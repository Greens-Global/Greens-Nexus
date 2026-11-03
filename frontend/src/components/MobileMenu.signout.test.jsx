import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Field offline (Neil, 11/03/2026): Sign Out on the MSAL path clears the
// phone's offline read cache and WAITS for it before the redirect to
// Microsoft (which would cut an unfinished clear off).
const order = [];
let release;
const logoutRedirect = vi.fn(() => { order.push('redirect'); return Promise.resolve(); });
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: { logoutRedirect }, accounts: [{ name: 'Crew Member', username: 'crew@example.com' }] }),
}));
vi.mock('../bffAuth', () => ({ BFF_MODE: false, bffLogout: vi.fn() }));
vi.mock('./Sidebar', () => ({ NAV: [] }));
vi.mock('../lib/offline/read', () => ({
  clearOfflineReadCache: vi.fn(() => new Promise((r) => { release = () => { order.push('cleared'); r(); }; })),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ myRole: 'employee', isExternal: false, can: () => false, myGrantedModules: new Map() }),
}));
vi.mock('../lib/peoplePhotos', () => ({ usePersonPhoto: () => '' }));

const MobileMenu = (await import('./MobileMenu')).default;

describe('mobile menu Sign Out', () => {
  it('clears the offline read cache, then redirects', async () => {
    render(<MobileMenu open onClose={() => {}} onNavigate={() => {}} activeView="tasks" />);
    fireEvent.click(screen.getByRole('button', { name: /Sign Out/ }));
    await Promise.resolve();
    expect(logoutRedirect).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(logoutRedirect).toHaveBeenCalled());
    expect(order).toEqual(['cleared', 'redirect']);
  });
});
