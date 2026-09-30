// Closed notifications (Neil, 10/01): clearing keeps a notification for 30
// days under the bell's Closed section, where Restore puts it back - so an
// accidental Clear All costs nothing. The open lists never show closed rows.
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

const row = (over) => ({
  recipient: 'sagar.shoundik@greensglobal.com', type: 'custom_alert', body: '', refId: '',
  read: true, actioned: false, timestamp: new Date().toISOString(), action: null, priority: 0, ...over,
});

describe('NotificationBell - Closed', () => {
  it('keeps cleared notifications under Closed and restores one', () => {
    notifications = [
      row({ id: 'open1', title: 'Still open' }),
      row({ id: 'gone1', title: 'Cleared by mistake', closed: true, priority: 1 }),
      row({ id: 'gone2', title: 'Cleared on purpose', closed: true }),
    ];
    render(<NotificationBell onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Still open')).toBeTruthy();
    // Closed rows are out of the open list, folded under their own heading.
    expect(screen.queryByText('Cleared by mistake')).toBeNull();
    const fold = screen.getByRole('button', { name: /Closed - 2/ });
    fireEvent.click(fold);
    expect(screen.getByText('Cleared by mistake')).toBeTruthy();
    expect(screen.getByText('Cleared on purpose')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]);
    expect(restore).toHaveBeenCalledWith('gone1');
    // A manager raises a priority notice from the bell.
    expect(screen.getByRole('button', { name: 'Raise a priority notice' })).toBeTruthy();
  });

  it('clearing closes instead of deleting', () => {
    notifications = [row({ id: 'u1', title: 'An update' })];
    render(<NotificationBell onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }));
    expect(dismiss).toHaveBeenCalledWith('u1');
  });
});
