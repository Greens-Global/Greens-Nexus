import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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
vi.mock('./MobileMenu', () => ({ SUBMENUS: {} }));

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
    expect(screen.getByText('Pages, tasks, projects, people, items and requests.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'hilti' } });
    expect(screen.getByText('Hilti Drill')).toBeTruthy();
    expect(screen.getByText('Tool · Checked Out')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'tick' } });
    expect(screen.getByText('Pages', { selector: '.gs-section' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close search'));
    expect(screen.queryByRole('search')).toBeNull();
  });
});
