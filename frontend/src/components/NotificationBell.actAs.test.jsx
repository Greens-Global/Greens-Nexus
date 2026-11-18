// Under Act As the server sends the acted-as person's notifications. The bell
// filtered them on the real account (the MSAL one), so every row addressed to
// the person being acted as was dropped and the bell read empty.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

let notifications = [];
let role = {};

vi.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    notifications, unreadCount: 0,
    markRead: vi.fn(), markAllRead: vi.fn(), dismiss: vi.fn(), restore: vi.fn(),
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
  useMsal: () => ({ accounts: [{ name: 'Ada Admin', username: 'ada.admin@greensglobal.com' }] }),
}));
vi.mock('../contexts/RoleContext', () => ({
  ROLES: { manager: { level: 3 }, employee: { level: 1 } },
  useRole: () => role,
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import NotificationBell from './NotificationBell';

const row = (over) => ({
  type: 'custom_alert', body: '', refId: '', read: false, actioned: false, closed: false,
  timestamp: new Date().toISOString(), action: null, priority: 0, ...over,
});
const base = { can: (r) => r === 'manager', myLevel: 3, myGrantedModules: new Map() };

afterEach(cleanup);

describe('NotificationBell - Act As', () => {
  it("lists the acted-as person's rows, open and closed, and counts them", () => {
    role = { ...base, myEmail: 'pat.target@greensglobal.com', realEmail: 'ada.admin@greensglobal.com',
      actingAs: { targetEmail: 'pat.target@greensglobal.com', targetName: 'Pat Target' } };
    notifications = [
      row({ id: 'p1', title: 'For Pat', recipient: 'pat.target@greensglobal.com' }),
      row({ id: 'p2', title: 'For Pat by name', recipient: 'Pat Target' }),
      row({ id: 'p3', title: 'Closed for Pat', recipient: 'pat.target@greensglobal.com', closed: true }),
      row({ id: 'a1', title: 'For Ada', recipient: 'ada.admin@greensglobal.com' }),
      row({ id: 'a2', title: 'For Ada by name', recipient: 'Ada Admin' }),
    ];
    render(<NotificationBell onNavigate={() => {}} />);
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(bell.querySelector('.nx-bell-count').textContent).toBe('2');
    fireEvent.click(bell);
    expect(screen.getByText('For Pat')).toBeTruthy();
    expect(screen.getByText('For Pat by name')).toBeTruthy();
    expect(screen.queryByText('For Ada')).toBeNull();
    expect(screen.queryByText('For Ada by name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Closed 1/ }));
    expect(screen.getByText('Closed for Pat')).toBeTruthy();
  });

  it('with nobody acted as, the signed-in account is the one', () => {
    role = { ...base, myEmail: 'ada.admin@greensglobal.com', actingAs: null };
    notifications = [
      row({ id: 'a1', title: 'For Ada', recipient: 'ada.admin@greensglobal.com' }),
      row({ id: 'a2', title: 'For Ada by name', recipient: 'Ada Admin' }),
      row({ id: 'p1', title: 'For Pat', recipient: 'pat.target@greensglobal.com' }),
    ];
    render(<NotificationBell onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('For Ada')).toBeTruthy();
    expect(screen.getByText('For Ada by name')).toBeTruthy();
    expect(screen.queryByText('For Pat')).toBeNull();
  });
});
