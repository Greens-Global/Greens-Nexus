// Favorites and Recents in the Nexus search (Neil, 11/07/2026): with nothing
// typed the sheet opens on the person's starred results and the last ones
// they opened; a pick is remembered, the star adds and removes, a bad saved
// entry is ignored, and a saved row opens the record the way the live row does.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const saveTaskTablePrefs = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock('../../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'saveTaskTablePrefs' ? saveTaskTablePrefs : () => Promise.resolve({ enabled: false })) }),
}));
vi.mock('../../contexts/RoleContext', () => ({
  useRole: () => ({ myRole: 'administrator', isExternal: false, can: () => true, myGrantedModules: new Map(), myEmail: 'pat@x.com' }),
}));
vi.mock('../../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [{ id: 'i1', name: 'Hilti Drill', itemType: 'Tool', status: 'available', ownershipType: 'transient' }], checkouts: [] }) }));
vi.mock('../../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));
vi.mock('../Sidebar', () => ({ NAV: [{ view: 'tickets', label: 'Tickets' }], isNavItemVisible: () => true }));
vi.mock('../MobileMenu', () => ({ SUBMENUS: {}, visibleSubs: () => null }));

const { default: GlobalSearch } = await import('../GlobalSearch');
const { __setTablePrefsCache } = await import('../../tasks/tableCols');

const saved = (data) => __setTablePrefsCache({ search: { data } });
const open = () => { render(<GlobalSearch />); fireEvent(window, new CustomEvent('nexus:search-open')); };

beforeEach(() => { saveTaskTablePrefs.mockClear(); });
afterEach(() => { cleanup(); __setTablePrefsCache(null); });

describe('Favorites and Recent', () => {
  it('nothing saved: the hint, as before', () => {
    saved({ favorites: [], recents: [] });
    open();
    expect(screen.getByText('Tasks, tickets, notes, documents, people, pages and actions.')).toBeTruthy();
  });

  it('opens on Favorites then Recent, a favorite never listed twice, a bad entry ignored', () => {
    saved({
      favorites: [{ key: 'item:i1', kind: 'item', title: 'Hilti Drill', detail: 'Tool', to: { view: 'inventory', sub: 'inventory@i1' } }],
      recents: [
        { key: 'item:i1', kind: 'item', title: 'Hilti Drill', detail: 'Tool', to: { view: 'inventory', sub: 'inventory@i1' } },
        { key: 'page:tickets:', kind: 'page', title: 'Tickets', detail: '', to: { view: 'tickets' } },
        { key: 'x', kind: 'payroll', title: 'Nope', to: { view: 'x' } },
        { key: 'y', kind: 'page', title: 'Evil', to: { view: 'javascript:alert(1)' } },
      ],
    });
    open();
    expect(screen.getByText('Favorites', { selector: '.gs-section' })).toBeTruthy();
    expect(screen.getByText('Recent', { selector: '.gs-section' })).toBeTruthy();
    expect(screen.getAllByText('Hilti Drill')).toHaveLength(1);
    expect(screen.getByText('Tickets')).toBeTruthy();
    expect(screen.queryByText('Nope')).toBeNull();
    expect(screen.queryByText('Evil')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Hilti Drill from Favorites' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a saved row opens its record, and a pick goes to the top of Recent', () => {
    saved({ favorites: [], recents: [{ key: 'page:tickets:', kind: 'page', title: 'Tickets', detail: '', to: { view: 'tickets' } }] });
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    open();
    fireEvent.click(screen.getByText('Tickets'));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'tickets', sub: undefined }]);
    expect(saveTaskTablePrefs).toHaveBeenCalledWith('search', { data: { favorites: [], recents: [expect.objectContaining({ key: 'page:tickets:' })] } });
  });

  it('a result picked from a search is remembered; the star adds it to Favorites', async () => {
    saved({ favorites: [], recents: [] });
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Nexus' }), { target: { value: 'hilti' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Hilti Drill to Favorites' }));
    expect(saveTaskTablePrefs).toHaveBeenLastCalledWith('search', {
      data: { favorites: [{ key: 'item:i1', kind: 'item', title: 'Hilti Drill', detail: 'Tool · Available', to: { view: 'inventory', sub: 'inventory@i1' } }], recents: [] },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Hilti Drill from Favorites' })).toBeTruthy());
    fireEvent.click(screen.getByText('Hilti Drill'));
    expect(saveTaskTablePrefs.mock.calls.at(-1)[1].data.recents[0].key).toBe('item:i1');
  });
});
