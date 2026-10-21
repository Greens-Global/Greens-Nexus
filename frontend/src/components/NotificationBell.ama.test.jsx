// An Ask My Accountant bell (Priyanka, 10/15: clicking "Open AMA" left her on
// a page that disappeared). Both ways in - the "Open AMA" label button and the
// card itself - must land on Accounting > AMA AND name the question, so the
// AMA tab opens its panel (AskAccountantTab drains the note on mount, or hears
// the live event when it is already up). Older rows carry no amaThreadId in
// their action; their refId is the question's id (accounting_ask._notify).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const notifications = [];

vi.mock('../contexts/NotificationContext', () => ({
  useNotifications: () => ({
    notifications, unreadCount: 0,
    markRead: vi.fn(), markAllRead: vi.fn(), dismiss: vi.fn(),
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
  useMsal: () => ({ accounts: [{ name: 'Priyanka Test', username: 'priyanka.test@greensglobal.com' }] }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myLevel: 1, myGrantedModules: new Map() }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import { takePendingOpen, __clearPendingOpen } from '../lib/pendingOpen';
import NotificationBell, { destinationFor } from './NotificationBell';

const THREAD = '3f1c2b7a-5a0e-4c55-9d7e-1b2a3c4d5e6f';
const amaNotification = (over = {}) => ({
  id: 'n-ama', type: 'acct_ama', recipient: 'priyanka.test@greensglobal.com',
  title: 'AMA Question: Entry GJ-100 · GL 99999 · $125.00', body: 'Val Viewer asked: Which property is this for?',
  refId: THREAD, read: false, actioned: false, createdAt: new Date().toISOString(),
  action: { view: 'accounting', sub: 'ama', label: 'Open AMA', amaThreadId: THREAD },
  ...over,
});

let opened;
const onOpen = (e) => opened.push(e.detail?.id);
const navigated = [];
const onNav = (e) => navigated.push(e.detail);

beforeEach(() => {
  opened = [];
  navigated.length = 0;
  notifications.length = 0;
  __clearPendingOpen();
  window.addEventListener('nexus:open-ama-thread', onOpen);
  window.addEventListener('nexus:navigate', onNav);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  window.removeEventListener('nexus:open-ama-thread', onOpen);
  window.removeEventListener('nexus:navigate', onNav);
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTime(1);

describe('"Open AMA" on an Ask My Accountant notification', () => {
  it('goes to Accounting > AMA and opens the question', () => {
    notifications.push(amaNotification());
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    fireEvent.click(screen.getByLabelText('Notifications'));
    fireEvent.click(screen.getByText('Open AMA'));
    flush();
    expect(onNavigate).toHaveBeenCalledWith('accounting', 'ama');
    expect(opened).toEqual([THREAD]);
    expect(takePendingOpen('amaThread')).toBe(THREAD);      // for an AMA tab still loading
  });

  it('does the same from the card itself', () => {
    notifications.push(amaNotification());
    render(<NotificationBell onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Notifications'));
    fireEvent.click(screen.getByText(/Which property is this for/));
    flush();
    expect(navigated).toEqual([{ view: 'accounting', sub: 'ama' }]);
    expect(opened).toEqual([THREAD]);
  });

  it('opens the question of an older row by its refId', () => {
    notifications.push(amaNotification({ action: { view: 'accounting', sub: 'ama', label: 'Open AMA' } }));
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    fireEvent.click(screen.getByLabelText('Notifications'));
    fireEvent.click(screen.getByText('Open AMA'));
    flush();
    expect(onNavigate).toHaveBeenCalledWith('accounting', 'ama');
    expect(opened).toEqual([THREAD]);
  });

  it('maps the type to the AMA tab', () => {
    expect(destinationFor(amaNotification())).toEqual(['accounting', 'ama']);
  });
});
