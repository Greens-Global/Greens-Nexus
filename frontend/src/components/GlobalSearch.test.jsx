import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { __resetBackToClose } from '../lib/useBackToClose';

// The search sheet: the same engine as the header bar, opened by the header's
// phone icon (nexus:search-open) or by Ctrl/Cmd+K wherever the header bar did
// not take the key first. Ctrl+K toggles it closed again.

vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({ enabled: false }) }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myRole: 'administrator', isExternal: false, can: () => true, myGrantedModules: new Map(), myEmail: 'pat@x.com' }),
}));
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [{ id: 'i1', name: 'Hilti Drill', itemType: 'Tool', status: 'checked_out', ownershipType: 'transient' }], checkouts: [] }) }));
vi.mock('../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));
vi.mock('./Sidebar', () => ({ NAV: [{ view: 'tickets', label: 'Tickets' }], isNavItemVisible: () => true }));
vi.mock('./MobileMenu', () => ({ SUBMENUS: {}, visibleSubs: () => null }));

const { default: GlobalSearch } = await import('./GlobalSearch');
afterEach(cleanup);

describe('GlobalSearch sheet', () => {
  it('Ctrl+K opens and closes it; a key the header already took is left alone', () => {
    render(<GlobalSearch />);
    expect(screen.queryByRole('search')).toBeNull();
    const taken = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true, bubbles: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(screen.queryByRole('search')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('search', { name: 'Search Nexus' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('the header icon opens it clean, and it finds the same things as the bar with Title Case statuses', () => {
    render(<GlobalSearch />);
    fireEvent(window, new CustomEvent('nexus:search-open'));
    const box = screen.getByRole('textbox', { name: 'Search Nexus' });
    expect(box.placeholder).toBe('Search Nexus');
    expect(screen.getByText('Tasks, tickets, notes, documents, people, pages and actions.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'hilti' } });
    expect(screen.getByText('Hilti Drill')).toBeTruthy();
    expect(screen.getByText('Tool · Checked Out')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'tick' } });
    expect(screen.getByText('Pages', { selector: '.gs-section' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close search'));
    expect(screen.queryByRole('search')).toBeNull();
  });

  // Escape was the input's own key handler: with the focus on the close
  // button or a result it did nothing.
  it('Escape closes it wherever the focus is', () => {
    render(<GlobalSearch />);
    fireEvent(window, new CustomEvent('nexus:search-open'));
    const x = screen.getByLabelText('Close search');
    x.focus();
    fireEvent.keyDown(x, { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
  });

  // On a phone the sheet is the whole screen, so the phone's Back closes it;
  // it used to change the screen underneath and leave the sheet open.
  it("on a phone, Back closes the sheet and the app's own listener never hears it", async () => {
    const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));   // jsdom runs back() asynchronously
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === '(max-width: 900px)', media: q, addEventListener() {}, removeEventListener() {} });
    const appPop = vi.fn();
    try {
      await settle();
      __resetBackToClose();
      window.history.replaceState({ depth: 1, fromLabel: 'Dashboard' }, '', '/tasks');
      window.addEventListener('popstate', appPop);
      render(<GlobalSearch />);
      fireEvent(window, new CustomEvent('nexus:search-open'));
      expect(screen.getByRole('search')).toBeTruthy();
      expect(window.history.state.nxSheet).toBeTruthy();
      await act(async () => { window.history.back(); });
      await settle();
      expect(screen.queryByRole('search')).toBeNull();
      expect(window.location.pathname).toBe('/tasks');
      expect(window.history.state).toEqual({ depth: 1, fromLabel: 'Dashboard' });
      expect(appPop).not.toHaveBeenCalled();
    } finally { window.removeEventListener('popstate', appPop); window.matchMedia = real; }
  });

  it('on a computer it takes no history entry', () => {
    window.history.replaceState({ depth: 1 }, '', '/tasks');
    render(<GlobalSearch />);
    fireEvent(window, new CustomEvent('nexus:search-open'));
    expect(window.history.state).toEqual({ depth: 1 });
  });
});
