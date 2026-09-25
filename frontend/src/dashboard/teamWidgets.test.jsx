// Render-smoke + data-shaping tests for the team widgets (phase 3, Sep 25):
// My Ticket Queue, Time Exceptions, Out Today, Pending Purchases. Manager
// tiles that crash would blank a saved view, so each one mounts against the
// real endpoint shapes (mocked) and the visible words are pinned.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getTaskTickets: vi.fn(), getMyTicketAccess: vi.fn(), timeExceptions: vi.fn(), getPeopleDirectory: vi.fn(),
  timeOffList: vi.fn(), getPurchaseRequests: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import { WIDGETS } from './widgets.jsx';
import { TicketQueueWidget, TimeExceptionsWidget, OutTodayWidget, PendingPurchasesWidget, ticketQueueRows, exceptionRows, outRows, purchaseRows } from './teamWidgets.jsx';
import { takePendingOpen, __clearPendingOpen } from '../lib/pendingOpen';

// Fixed "now": Friday 09/25/2026 10:00 local.
const NOW = new Date(2026, 8, 25, 10, 0);
const iso = (d) => d.toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  __clearPendingOpen();
  apiMock.getTaskTickets.mockResolvedValue([]);
  apiMock.getMyTicketAccess.mockResolvedValue({ onDesk: false, canAct: false });
  apiMock.timeExceptions.mockResolvedValue([]);
  apiMock.getPeopleDirectory.mockResolvedValue([]);
  apiMock.timeOffList.mockResolvedValue([]);
  apiMock.getPurchaseRequests.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); });

const tickets = [
  { id: 't1', code: 'TK-101', subject: 'Printer jam', status: 'open', priority: 'low', assigneeId: 'neil@greensglobal.com', createdAt: iso(new Date(NOW - 3 * 86400000)) },
  { id: 't2', code: 'TK-102', subject: 'VPN down', status: 'in_progress', priority: 'urgent', assigneeId: 'NEIL@greensglobal.com', createdAt: iso(new Date(NOW - 86400000)), slaDueOn: '2026-09-20' },
  { id: 't3', code: 'TK-103', subject: 'Old one', status: 'resolved', priority: 'high', assigneeId: 'neil@greensglobal.com', createdAt: iso(NOW) },
  { id: 't4', code: 'TK-104', subject: 'New laptop', status: 'open', priority: 'medium', assigneeId: '', createdAt: iso(NOW) },
  { id: 't5', code: 'TK-105', subject: 'Someone else', status: 'open', priority: 'high', assigneeId: 'ankush@greensglobal.com', createdAt: iso(NOW) },
];

describe('My Ticket Queue', () => {
  it('lists open tickets assigned to me, SLA breaches first, and unassigned only for desk members', () => {
    const off = ticketQueueRows(tickets, 'neil@greensglobal.com', false);
    expect(off.mine.map(r => r.title)).toEqual(['TK-102 · VPN down', 'TK-101 · Printer jam']);
    expect(off.mine[0].statusLabel).toBe('SLA breached');
    expect(off.unassigned).toEqual([]);
    const desk = ticketQueueRows(tickets, 'neil@greensglobal.com', true);
    expect(desk.unassigned.map(r => r.title)).toEqual(['TK-104 · New laptop']);
  });

  it('renders sections for desk members and opens a ticket in place', async () => {
    apiMock.getTaskTickets.mockResolvedValue(tickets);
    apiMock.getMyTicketAccess.mockResolvedValue({ onDesk: true, canAct: true });
    const seen = [];
    const onNav = (e) => seen.push(['nav', e.detail.view]);
    const onOpen = (e) => seen.push(['open', e.detail.ticketId]);
    window.addEventListener('nexus:navigate', onNav);
    window.addEventListener('nexus:open-ticket', onOpen);
    render(<TicketQueueWidget />);
    expect(await screen.findByText('TK-104 · New laptop')).toBeTruthy();
    expect(screen.getByText('Assigned to me')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('2 assigned to you, 1 unassigned')).toBeTruthy();
    fireEvent.click(screen.getByText('TK-102 · VPN down'));
    await vi.advanceTimersByTimeAsync(5);
    expect(seen).toEqual([['nav', 'tickets'], ['open', 't2']]);
    expect(takePendingOpen('ticket')).toBe('t2');
    window.removeEventListener('nexus:navigate', onNav);
    window.removeEventListener('nexus:open-ticket', onOpen);
  });

  it('shows the empty state for a non-desk supervisor', async () => {
    render(<TicketQueueWidget />);
    expect(await screen.findByText('No open tickets assigned to you.')).toBeTruthy();
  });
});

describe('Time Exceptions', () => {
  it('maps emails to names, counts blocking first, and skips clean employees', () => {
    const rows = exceptionRows([
      { email: 'a@g.com', exceptions: [{ date: '2026-09-20', type: 'missing_out', label: 'Missing punch out', blocking: true }, { date: '2026-09-22', type: 'long_shift', label: 'Long shift', blocking: false }], blocking: 1 },
      { email: 'b@g.com', exceptions: [], blocking: 0 },
      { email: 'c@g.com', exceptions: [{ date: '2026-09-24', type: 'long_shift', label: 'Long shift', blocking: false }], blocking: 0 },
    ], [{ email: 'A@g.com', name: 'Ava Adams' }]);
    expect(rows.map(r => r.title)).toEqual(['Ava Adams', 'c@g.com']);
    expect(rows[0].statusLabel).toBe('1 blocking');
    expect(rows[0].meta).toBe('Missing punch out, Long shift · latest 09/22/2026');
    expect(rows[1].statusLabel).toBe('1 to review');
  });

  it('asks for the last 14 days and shows the access hint on 403', async () => {
    apiMock.timeExceptions.mockRejectedValue({ status: 403 });
    render(<TimeExceptionsWidget />);
    expect(await screen.findByText(/needs Time editor access/)).toBeTruthy();
    expect(apiMock.timeExceptions).toHaveBeenCalledWith('2026-09-11', '2026-09-25');
  });
});

describe('Out Today', () => {
  it('splits approved time off into today and the next 7 days, every day of a range', () => {
    const { today, upcoming } = outRows([
      { id: 1, name: 'Ava', type: 'vacation', status: 'approved', startDate: '2026-09-24', endDate: '2026-09-28' },
      { id: 2, name: 'Ben', type: 'sick', status: 'approved', startDate: '2026-09-25', endDate: '2026-09-25', startTime: '13:00', endTime: '17:00' },
      { id: 3, name: 'Cal', type: 'personal', status: 'pending', startDate: '2026-09-25', endDate: '2026-09-25' },
      { id: 4, name: 'Dee', type: 'vacation', status: 'approved', startDate: '2026-09-29', endDate: '2026-09-30' },
      { id: 5, name: 'Eve', type: 'vacation', status: 'approved', startDate: '2026-10-20', endDate: '2026-10-21' },
    ], NOW);
    expect(today.map(r => r.title)).toEqual(['Ava', 'Ben']);
    expect(today[0].meta).toBe('Vacation · back 09/29/2026');
    expect(today[1].statusLabel).toBe('Partial');
    expect(upcoming.map(u => [u.date, u.names.join(',')])).toEqual([
      ['2026-09-26', 'Ava'], ['2026-09-27', 'Ava'], ['2026-09-28', 'Ava'], ['2026-09-29', 'Dee'], ['2026-09-30', 'Dee'],
    ]);
  });

  it('renders today rows and the upcoming lines', async () => {
    apiMock.timeOffList.mockResolvedValue([
      { id: 1, name: 'Ava', type: 'vacation', status: 'approved', startDate: '2026-09-25', endDate: '2026-09-25' },
      { id: 4, name: 'Dee', type: 'vacation', status: 'approved', startDate: '2026-09-26', endDate: '2026-09-26' },
    ]);
    render(<OutTodayWidget />);
    expect(await screen.findByText('Ava')).toBeTruthy();
    expect(screen.getByText('1 out')).toBeTruthy();
    expect(screen.getByText('Tomorrow')).toBeTruthy();
    expect(screen.getByText('Dee')).toBeTruthy();
    expect(apiMock.timeOffList).toHaveBeenCalledWith('approved');
  });
});

describe('Pending Purchases', () => {
  it('keeps pending rows, totals cost by quantity, biggest first', () => {
    const rows = purchaseRows([
      { id: 1, item: 'Monitors', vendor: 'Dell', cost: 300, qty: 4, dept: 'IT', status: 'pending' },
      { id: 2, item: 'Chairs', vendor: '', cost: 250, qty: 1, dept: 'Ops', status: 'pending' },
      { id: 3, item: 'Approved', cost: 999, qty: 1, dept: 'Ops', status: 'approved' },
    ]);
    expect(rows.map(r => r.title)).toEqual(['Monitors', 'Chairs']);
    expect(rows[0].statusLabel).toBe('$1,200');
    expect(rows[0].meta).toBe('IT · Dell · qty 4');
  });

  it('renders the header total and the empty state', async () => {
    apiMock.getPurchaseRequests.mockResolvedValue([{ id: 1, item: 'Monitors', vendor: 'Dell', cost: 300, qty: 4, dept: 'IT', status: 'pending' }]);
    const { unmount } = render(<PendingPurchasesWidget />);
    expect(await screen.findByText('Monitors')).toBeTruthy();
    expect(screen.getByText('1 pending · $1,200')).toBeTruthy();
    unmount();
    apiMock.getPurchaseRequests.mockResolvedValue([]);
    render(<PendingPurchasesWidget />);
    expect(await screen.findByText('No pending purchase requests.')).toBeTruthy();
  });
});

describe('registry', () => {
  it('registers the four tiles under Team with the server-side role levels', () => {
    expect(WIDGETS['ticket-queue']).toMatchObject({ cat: 'Team', minRole: 'supervisor' });
    for (const k of ['time-exceptions', 'out-today', 'pending-purchases']) expect(WIDGETS[k]).toMatchObject({ cat: 'Team', minRole: 'manager' });
  });
});
