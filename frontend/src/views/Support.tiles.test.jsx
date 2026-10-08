import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Neil, Oct 1 2026: Report a Bug is folded into Submit a Ticket (a bug is just
// the Bug Report type there), so the Support page no longer has its own tile.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  // Tour already seen, so it does not cover the page.
  const named = { getToursSeen: () => Promise.resolve({ seen: { support: true } }) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});

const { default: Support } = await import('./Support');

afterEach(cleanup);

describe('Support page tiles', () => {
  it('offers Submit a Ticket and no longer a separate Report a Bug tile', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByText('Submit a Ticket', { selector: '.support-card-title' })).toBeTruthy();
    expect(screen.queryByText('Report a Bug')).toBeNull();
    expect(document.querySelector('[data-tour="support-report-bug"]')).toBeNull();
    // The bug path is named on the ticket tile instead.
    expect(screen.getByText(/Report an issue or a bug/)).toBeTruthy();
  });
});
