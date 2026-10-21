import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// Purchase Requisition moved from Item Management to Workday (Neil, Oct 22
// 2026): the landing card, the "raise a purchase requisition" link and the
// managers' Purchase Requests tab are gone from Item Management.

const { role } = vi.hoisted(() => ({ role: { manager: false } }));
vi.mock('../contexts/InventoryContext', () => ({
  useInventory: () => ({
    items: [], itemsLoading: false, itemsError: null,
    checkouts: [], checkoutsLoading: false, checkoutsError: null,
    submitCartCheckouts: vi.fn(), approveRequest: vi.fn(), rejectRequest: vi.fn(),
    allocateItem: vi.fn(), initiateHandover: vi.fn(), confirmReceipt: vi.fn(), returnItem: vi.fn(), cancelRequest: vi.fn(),
    refreshItems: vi.fn(), refreshCheckouts: vi.fn(),
    patchItemLocal: vi.fn(), removeItemsLocal: vi.fn(), addItemLocal: vi.fn(),
  }),
}));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ addNotification: vi.fn(), notifications: [] }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: () => role.manager, canAccessModule: () => role.manager, loading: false,
    myGrantedModules: new Map(), myEmail: 'erin@greensglobal.com',
  }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Erin Test', username: 'erin@greensglobal.com' }] }),
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }), useItemApprovers: () => ({ data: [] }) }));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: () => vi.fn(async () => []) });
  return { api, default: api };
});

import InventoryManagement from './InventoryManagement';
import { HeaderTabsProvider, useHeaderTabs } from '../components/ModuleTabs';

// The manager tab strip is published to the top header - read it back.
function HeaderTabs() {
  const entry = useHeaderTabs();
  return <div data-testid="header-tabs">{(entry?.tabs || []).map((t) => t.label).join('|')}</div>;
}

beforeEach(() => { try { localStorage.removeItem('nexus_inv_tab'); } catch { /* ignore */ } });
afterEach(cleanup);

describe('Item Management without purchase requests', () => {
  it('has no Purchase Request card or requisition link on the home screen', async () => {
    render(<InventoryManagement activeSub={null} />);
    expect(await screen.findByText('Check Out an Item')).toBeTruthy();
    expect(screen.queryByText('Purchase Request')).toBeNull();
    expect(screen.queryByText(/purchase requisition/i)).toBeNull();
  });

  it('has no Purchase Requests tab for managers', async () => {
    role.manager = true;
    try {
      render(<HeaderTabsProvider><HeaderTabs /><InventoryManagement activeSub="manage" /></HeaderTabsProvider>);
      await waitFor(() => expect(screen.getByTestId('header-tabs').textContent).toContain('Who Has What'));
      expect(screen.getByTestId('header-tabs').textContent.split('|')).toEqual(
        ['My Items', 'Catalog', 'Manage', 'Checkouts', 'Who Has What', 'Activity Log']);
      expect(screen.queryByText('Purchase Requests')).toBeNull();
      expect(screen.queryByText(/request a purchase/i)).toBeNull();
    } finally {
      role.manager = false;
    }
  });
});
