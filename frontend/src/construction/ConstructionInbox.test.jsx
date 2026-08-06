import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The module's own notification strip.
//
// Why it exists at all is worth stating: the global bell
// (components/NotificationBell.jsx) indexes TYPE_META by notification type and
// dereferences the result with no fallback, so a type it has not been taught
// throws at render. That file belongs to another developer per CLAUDE.md's
// ownership table, so this module surfaces its own notifications instead of
// adding entries to a map it does not own.
//
// The last test below is the one that matters most: this component must not
// reproduce the bug it exists because of.

const api = { getNotifications: vi.fn(), markNotifRead: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: ConstructionInbox } = await import('./ConstructionInbox');

const notif = (over = {}) => ({
  id: 'n1', type: 'construction_log_needs_info', recipient: 'sagar@greensglobal.com',
  title: 'Daily log sent back', body: '2026-08-05 on Valley Center Phase 2: Which elevation is the crack on?',
  refId: 'log-1', action: { view: 'ops', sub: 'ops-dashboard' }, actioned: false,
  read: false, timestamp: '2026-08-06T09:00:00Z', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.markNotifRead.mockResolvedValue({});
});

describe('ConstructionInbox', () => {
  it('shows an unread construction notification with the question in it', async () => {
    api.getNotifications.mockResolvedValue([notif()]);
    render(<ConstructionInbox />);
    expect(await screen.findByText('Daily log sent back')).toBeTruthy();
    expect(screen.getByText(/Which elevation is the crack on\?/)).toBeTruthy();
  });

  it('ignores other modules notifications', async () => {
    // The endpoint is the whole company's bell feed. A task assignment showing
    // up on the jobsite dashboard would be somebody else's noise.
    api.getNotifications.mockResolvedValue([
      notif(), { ...notif({ id: 'n2', type: 'task_task_assigned', title: 'You were assigned a task' }) },
    ]);
    render(<ConstructionInbox />);
    await screen.findByText('Daily log sent back');
    expect(screen.queryByText('You were assigned a task')).toBeNull();
  });

  it('renders nothing at all when there is nothing waiting', async () => {
    api.getNotifications.mockResolvedValue([]);
    const { container } = render(<ConstructionInbox />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('does not show notifications already read', async () => {
    api.getNotifications.mockResolvedValue([notif({ read: true })]);
    const { container } = render(<ConstructionInbox />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('dismissing marks it read and removes it immediately', async () => {
    api.getNotifications.mockResolvedValue([notif()]);
    render(<ConstructionInbox />);
    await screen.findByText('Daily log sent back');
    fireEvent.click(screen.getByTitle('Mark as read'));
    expect(api.markNotifRead).toHaveBeenCalledWith('n1');
    await waitFor(() => expect(screen.queryByText('Daily log sent back')).toBeNull());
  });

  it('survives the notifications endpoint failing', async () => {
    // A dashboard that dies because an extra strip could not load its data is
    // worse than a dashboard with no strip.
    api.getNotifications.mockRejectedValue(new Error('503'));
    const { container } = render(<ConstructionInbox />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('survives the api method being missing entirely', async () => {
    // Not hypothetical: a test harness that mocks the api module without this
    // method is exactly how this was found, and the call throws SYNCHRONOUSLY -
    // straight through the effect, past any .catch, into the dashboard. This
    // strip must never be the thing that breaks the screen it decorates.
    api.getNotifications.mockImplementation(() => { throw new TypeError('not a function'); });
    const { container } = render(<ConstructionInbox />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders an unknown construction kind instead of crashing on it', async () => {
    // The exact bug this component exists because of: the global bell does
    // TYPE_META[n.type].color with no fallback, so a type added by a later
    // release throws at render. A new construction_* kind must degrade here,
    // not take the jobsite dashboard down with it.
    api.getNotifications.mockResolvedValue([
      notif({ id: 'n9', type: 'construction_something_new', title: 'A kind from the future' }),
    ]);
    render(<ConstructionInbox />);
    expect(await screen.findByText('A kind from the future')).toBeTruthy();
  });

  it('counts what is waiting', async () => {
    api.getNotifications.mockResolvedValue([
      notif(), notif({ id: 'n2', type: 'construction_log_submitted', title: 'Daily log ready to review' }),
    ]);
    render(<ConstructionInbox />);
    await screen.findByText('Daily log sent back');
    expect(screen.getByText('2')).toBeTruthy();
  });
});
