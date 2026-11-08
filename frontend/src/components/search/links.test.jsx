// Links in the Nexus search (11/08/2026): company links and the person's
// own are found by name, description and site; a pick opens the site in a
// new tab and records the click; a starred link reopens the same way.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const calls = vi.hoisted(() => ({ clickExternalLink: vi.fn(() => Promise.resolve({})), clickPersonalLink: vi.fn(() => Promise.resolve({})) }));
vi.mock('../../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => {
      if (k === 'getExternalLinks') return () => Promise.resolve([
        { id: 7, name: 'Bank of America', url: 'https://www.bankofamerica.com/', description: 'Business banking', categories: ['Banking'] },
        { id: 8, name: 'Outlook', url: 'https://outlook.office.com/mail/', description: 'Company email', categories: ['Productivity'] },
      ]);
      if (k === 'getPersonalLinks') return () => Promise.resolve([{ id: 3, name: 'My Bank', url: 'https://chase.com/', description: '', category: '' }]);
      if (k in calls) return calls[k];
      if (k === 'saveTaskTablePrefs') return () => Promise.resolve({});
      return () => Promise.resolve({ enabled: false });
    },
  }),
}));
vi.mock('../../contexts/RoleContext', () => ({
  useRole: () => ({ myRole: 'employee', isExternal: false, can: () => false, myGrantedModules: new Map(), myEmail: 'pat@x.com' }),
}));
vi.mock('../../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [], checkouts: [] }) }));
vi.mock('../../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));
vi.mock('../Sidebar', () => ({ NAV: [], isNavItemVisible: () => true }));
vi.mock('../MobileMenu', () => ({ SUBMENUS: {}, visibleSubs: () => null }));

const { default: GlobalSearch } = await import('../GlobalSearch');
const { resetLinksSearchCache } = await import('./useNexusSearch');
const { __setTablePrefsCache } = await import('../../tasks/tableCols');

const open = (q) => {
  render(<GlobalSearch />);
  fireEvent(window, new CustomEvent('nexus:search-open'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: q } });
};

beforeEach(() => { resetLinksSearchCache(); __setTablePrefsCache({ search: { data: { favorites: [], recents: [] } } }); window.open = vi.fn(); calls.clickExternalLink.mockClear(); calls.clickPersonalLink.mockClear(); });
afterEach(() => { cleanup(); __setTablePrefsCache(null); });

describe('Links in search', () => {
  it('finds a company link by its site and a personal one by name, under one Links group', async () => {
    open('bank');
    expect(await screen.findByText('Links')).toBeTruthy();
    expect(screen.getByText('Bank of America')).toBeTruthy();
    expect(screen.getByText('Banking · bankofamerica.com')).toBeTruthy();
    expect(screen.getByText('My Bank')).toBeTruthy();
    expect(screen.getByText('Personal · chase.com')).toBeTruthy();
    expect(screen.queryByText('Outlook')).toBeNull();
  });

  it('a pick opens the site in a new tab and records the click', async () => {
    open('outlook');
    fireEvent.click(await screen.findByText('Outlook'));
    expect(window.open).toHaveBeenCalledWith('https://outlook.office.com/mail/', '_blank', 'noopener');
    expect(calls.clickExternalLink).toHaveBeenCalledWith(8);
  });

  it('Enter opens the first result', async () => {
    open('chase');
    await screen.findByText('My Bank');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(window.open).toHaveBeenCalledWith('https://chase.com/', '_blank', 'noopener');
    expect(calls.clickPersonalLink).toHaveBeenCalledWith(3);
  });
});
