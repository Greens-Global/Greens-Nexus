import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

// Support's own ticket list (Neil, Oct 1 2026): the tabs read "Open Tickets" /
// "Closed Tickets" (no "My" - the page is only yours), every row ends with the
// latest public reply, and a ticket still in flight can be marked Resolved.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myLevel: 1, canAccessModule: () => false,
    myGrantedModules: new Set(), myEmail: 'req@example.com' }),
}));
const MINE = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', requesterId: 'req@example.com', assigneeId: 'agent@example.com',
    createdAt: '2026-09-30T10:00:00', latestComment: { authorId: 'agent@example.com', preview: 'On my way', createdAt: '2026-09-30T11:00:00', internal: false } },
  { id: 't2', code: '000002', subject: 'Old laptop', status: 'closed', requesterId: 'req@example.com', createdAt: '2026-09-01T10:00:00', latestComment: null },
  // Raised BY the requester FOR a colleague: followed, not owned (Neil, Oct 12).
  { id: 't3', code: '000003', subject: 'Desk lamp for Sam', status: 'new', requesterId: 'sam@example.com', createdById: 'req@example.com',
    watcherIds: ['req@example.com'], createdAt: '2026-10-01T10:00:00', latestComment: null },
  // Only watching someone else's ticket: followed too.
  { id: 't4', code: '000004', subject: 'Lobby door', status: 'in_progress', requesterId: 'kim@example.com', createdById: 'kim@example.com',
    watcherIds: ['req@example.com'], createdAt: '2026-10-02T10:00:00', latestComment: null },
];
const updateTaskTicket = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => {
  const answer = (k) => (k === 'getToursSeen' ? { seen: { support: true } } : k === 'getMyTickets' ? MINE : []);
  return { api: new Proxy({}, { get: (_, k) => (k === 'updateTaskTicket' ? updateTaskTicket : () => Promise.resolve(answer(k))) }) };
});

const { default: Support } = await import('./Support');

afterEach(() => { cleanup(); updateTaskTicket.mockClear(); });

describe('Support - your tickets', () => {
  it('labels the tabs Open Tickets, Tickets I\'m Following and Closed Tickets', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByRole('tab', { name: /^Open Tickets/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Tickets I'm Following/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Closed Tickets/ })).toBeTruthy();
    expect(screen.queryByText(/My Open Tickets|My Closed Tickets/)).toBeNull();
  });

  it('keeps Open Tickets to what is FOR me; tickets I raised for others or watch are under Following', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByText('Printer jam')).toBeTruthy();
    expect(screen.queryByText('Desk lamp for Sam')).toBeNull();
    expect(screen.queryByText('Lobby door')).toBeNull();
    expect(screen.getByRole('tab', { name: /^Open Tickets/ }).textContent).toMatch(/1$/);
    const following = screen.getByRole('tab', { name: /^Tickets I'm Following/ });
    expect(following.textContent).toMatch(/2$/);
    await act(async () => { fireEvent.click(following); });
    expect(await screen.findByText('Desk lamp for Sam')).toBeTruthy();
    expect(screen.getByText('Lobby door')).toBeTruthy();
    expect(screen.queryByText('Printer jam')).toBeNull();
    // Someone else's ticket: no Mark Resolved / Confirm for me, the owner
    // is named under the title instead.
    expect(screen.queryByRole('button', { name: /Mark Resolved/ })).toBeNull();
    expect(screen.getAllByText(/^For /).length).toBe(2);
  });

  it('shows the latest comment and lets the requester mark an in-flight ticket Resolved', { timeout: 20000 }, async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    expect(await screen.findByText(/On my way/)).toBeTruthy();
    expect(screen.getByText('Latest Comment')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark Resolved/ })); });
    expect(await screen.findByText('What fixed it? (optional)', {}, { timeout: 10000 })).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Mark Resolved' });
    await act(async () => { fireEvent.click(buttons[buttons.length - 1]); });
    expect(updateTaskTicket).toHaveBeenCalledWith('t1', { status: 'resolved' });
  });
});
