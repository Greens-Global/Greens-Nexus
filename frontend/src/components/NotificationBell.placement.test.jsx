// The panel is drawn on <body>, not inside the header (11/17/2026): the phone
// header's -webkit-backdrop-filter made it the frame for the fixed panel in
// Safari, so the panel's top - the title and the close button - sat above the
// screen and could not be closed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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

afterEach(cleanup);

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

  // The closed panel stays in the page. As a standing role="dialog" it made
  // every "is a popup open?" check answer yes on every screen: the header's
  // Ctrl+F and C then T stood down, as did Approvals' keys and Escape in
  // Purchase Requests, Links and Accounting Reports.
  it('a closed bell leaves no dialog in the document', () => {
    render(<NotificationBell onNavigate={() => {}} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const panel = document.querySelector('.notif-drawer');
    expect(panel.classList.contains('nx-sheet')).toBe(true);   // the phone CSS's own shape
    expect(panel.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(document.querySelector('[role="dialog"]')).toBe(panel);
    expect(panel.hasAttribute('inert')).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(panel.hasAttribute('inert')).toBe(true);
  });

  // On a phone the panel is the whole screen: over Tasks' floating List / +
  // bar (z 2500), which painted on it and took taps. A computer keeps 1201.
  it('is the top layer on a phone, above the module floats', () => {
    const { unmount } = render(<NotificationBell onNavigate={() => {}} />);
    expect(document.querySelector('.notif-drawer').style.zIndex).toBe('1201');
    unmount();
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === '(max-width: 640px)', media: q, addEventListener() {}, removeEventListener() {} });
    try {
      render(<NotificationBell onNavigate={() => {}} />);
      const panel = document.querySelector('.notif-drawer');
      expect(Number(panel.style.zIndex)).toBeGreaterThan(2500);
      expect(Number(panel.previousElementSibling.style.zIndex)).toBeGreaterThan(2500);   // its backdrop
      expect(Number(panel.style.zIndex)).toBeLessThan(4000);   // popups (Raise a Notice, Hand Over) stay above
    } finally { window.matchMedia = real; }
  });
});
