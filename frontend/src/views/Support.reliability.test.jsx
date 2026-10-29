import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { setPendingOpen, takePendingOpen } from '../lib/pendingOpen';

// The requester's list when things go wrong (Oct 28 2026 review): a failed
// load is said with Retry, never shown as "nothing open"; a ticket filed from
// anywhere appears without a reload; and a ticket opened by event leaves no
// note behind to reopen it on the next visit.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myLevel: 1, canAccessModule: () => false,
    myGrantedModules: new Set(), myEmail: 'req@example.com' }),
}));
const ROW = { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', requesterId: 'req@example.com',
  createdAt: '2026-09-30T10:00:00', latestComment: null };
const getMyTickets = vi.fn();
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'getMyTickets' ? getMyTickets
    : () => Promise.resolve(k === 'getToursSeen' ? { seen: { support: true } } : [])) }),
}));

const { default: Support } = await import('./Support');

afterEach(() => { cleanup(); getMyTickets.mockReset(); });

describe('Support - the ticket list when loading fails or changes', () => {
  it('says a failed load with Retry instead of "Nothing open right now", and clears it once Retry works', async () => {
    getMyTickets.mockRejectedValueOnce(new Error('Could not reach Nexus.')).mockResolvedValueOnce([ROW]);
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByText('Could not reach Nexus.')).toBeTruthy();
    expect(screen.queryByText('Nothing open right now')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry/ })); });
    expect(await screen.findByText('Printer jam')).toBeTruthy();
    expect(screen.queryByText('Could not reach Nexus.')).toBeNull();
  });

  it('reloads when a ticket is created anywhere', async () => {
    getMyTickets.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByText('Nothing open right now')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new CustomEvent('nexus:tickets-changed', { detail: { propertyId: '' } })); });
    expect(await screen.findByText('Printer jam')).toBeTruthy();
  });

  it('keeps the newest answer when two loads come back out of order', async () => {
    let first;
    getMyTickets
      .mockImplementationOnce(() => new Promise((r) => { first = r; }))
      .mockResolvedValueOnce([ROW]);
    render(<Support activeSub={null} onSubChange={() => {}} />);
    await act(async () => { window.dispatchEvent(new CustomEvent('nexus:tickets-changed')); });
    expect(await screen.findByText('Printer jam')).toBeTruthy();
    await act(async () => { first([]); });
    expect(screen.getByText('Printer jam')).toBeTruthy();
  });

  it('takes the "open this ticket" note when it hears the event, so it cannot reopen later', async () => {
    getMyTickets.mockResolvedValue([ROW]);
    render(<Support activeSub={null} onSubChange={() => {}} />);
    await screen.findByText('Printer jam');
    setPendingOpen('ticket', 't1');
    await act(async () => { window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: 't1' } })); });
    expect(takePendingOpen('ticket')).toBeNull();
  });
});
