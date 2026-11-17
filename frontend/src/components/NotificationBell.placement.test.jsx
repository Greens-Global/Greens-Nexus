// The panel is drawn on <body>, not inside the header (11/17/2026): the phone
// header's -webkit-backdrop-filter made it the frame for the fixed panel in
// Safari, so the panel's top - the title and the close button - sat above the
// screen and could not be closed.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let notifications = [];
const dismiss = vi.fn();
const restore = vi.fn();

vi.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    notifications, unreadCount: 0,
    markRead: vi.fn(), markAllRead: vi.fn(), dismiss, restore,
    addNotification: vi.fn(), markActioned: vi.fn(),
    pendingApprovalId: null, clearPendingApproval: vi.fn(),
  }),
}));
vi.mock('../contexts/InventoryContext', () => ({
  useInventory: () => ({ approveRequest: vi.fn(), allocateItem: vi.fn(), requests: [], requestsLoading: false, refreshRequests: vi.fn() }),
}));
vi.mock('../contexts/RequisitionContext', () => ({
  useRequisitions: () => ({ approveRequisition: vi.fn(), rejectRequisition: vi.fn() }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Sagar Shoundik', username: 'sagar.shoundik@greensglobal.com' }] }),
}));
vi.mock('../contexts/RoleContext', () => ({
  ROLES: { manager: { level: 3 }, employee: { level: 1 } },
  useRole: () => ({ can: (r) => r === 'manager', myLevel: 3, myGrantedModules: new Map() }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import NotificationBell from './NotificationBell';

describe('NotificationBell - placement', () => {
  it('draws the panel and its backdrop on <body>, outside the header', () => {
    const { container } = render(<header className="top-header" style={{ WebkitBackdropFilter: 'blur(12px)' }}>
      <NotificationBell onNavigate={() => {}} />
    </header>);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    const panel = screen.getByRole('dialog', { name: 'Notifications Panel' });
    expect(panel.parentElement).toBe(document.body);
    expect(container.querySelector('header').contains(panel)).toBe(false);
    // Its close button is there to press.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(panel.hasAttribute('inert')).toBe(true);
  });
});
