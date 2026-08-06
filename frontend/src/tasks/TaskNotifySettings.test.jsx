import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke + behavior for the admin panel that turns email replies on and
// shows what the mailbox did with them. Same guard as richlist.test.jsx: this
// screen is only ever opened by an admin, so a crash-on-render here would sit
// undiscovered until the one person who needed it went looking.

const settings = {
  fromMailbox: 'tasks@greensglobal.com', defaultCc: [], replyTo: 'tasks@greensglobal.com',
  logoUrl: '', dueSoonDays: 2, overdueRepeatDays: 3,
  inboundEnabled: false, inboundMailbox: '',
  enabledEvents: { created: true, assigned: true, commented: true },
};

const api = {
  getTaskNotifySettings: vi.fn(),
  updateTaskNotifySettings: vi.fn(),
  getTaskNotifyLog: vi.fn(() => Promise.resolve([])),
  getTaskInboundLog: vi.fn(() => Promise.resolve([])),
  drainTaskInbox: vi.fn(),
};

vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myLevel: 3 }) }));
// The Replies log resolves each row's task code from the store, and opens the
// drawer on click. Neither needs the real provider here.
vi.mock('./TasksContext', () => ({
  useTasks: () => ({ taskById: { t1: { id: 't1', code: 'TASK-069', title: 'Replace the pump seal' } } }),
}));
vi.mock('./TaskDetailDrawer', () => ({
  default: ({ taskId, initialTab }) => <div data-testid="drawer">{`drawer:${taskId}:${initialTab}`}</div>,
}));

const { default: TaskNotifySettings } = await import('./TaskNotifySettings');

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskNotifySettings.mockResolvedValue({ ...settings });
  api.getTaskNotifyLog.mockResolvedValue([]);
  api.getTaskInboundLog.mockResolvedValue([]);
});

const openReplies = async () => {
  render(<TaskNotifySettings />);
  await screen.findByText('Accept replies by email');
  fireEvent.click(screen.getByText('Replies'));
};

describe('inbound email settings', () => {
  it('renders the switch without a mailbox configured', async () => {
    api.getTaskNotifySettings.mockResolvedValue({ ...settings, replyTo: '', inboundMailbox: '' });
    render(<TaskNotifySettings />);
    expect(await screen.findByText('Accept replies by email')).toBeTruthy();
  });

  it('hides the mailbox details until replies are switched on', async () => {
    render(<TaskNotifySettings />);
    await screen.findByText('Accept replies by email');
    expect(screen.queryByText('Check Mailbox Now')).toBeNull();
  });

  it('shows the signed per-task reply address, not the bare mailbox', async () => {
    // The first thing that looks wrong to an admin reading a sent notification
    // is the "+" suffix, so the panel has to explain it.
    api.getTaskNotifySettings.mockResolvedValue({ ...settings, inboundEnabled: true });
    render(<TaskNotifySettings />);
    expect(await screen.findByText(/tasks\+a1b2…@greensglobal\.com/)).toBeTruthy();
  });

  it('reports what a manual check found', async () => {
    api.getTaskNotifySettings.mockResolvedValue({ ...settings, inboundEnabled: true });
    api.drainTaskInbox.mockResolvedValue({ seen: 3, posted: 2, rejected: 1, ignored: 0, failed: 0 });
    render(<TaskNotifySettings />);
    fireEvent.click(await screen.findByText('Check Mailbox Now'));
    expect(await screen.findByText(/3 messages: 2 posted, 1 refused/)).toBeTruthy();
  });

  it('surfaces a missing mailbox grant instead of failing silently', async () => {
    api.getTaskNotifySettings.mockResolvedValue({ ...settings, inboundEnabled: true });
    api.drainTaskInbox.mockRejectedValue(new Error('Could not read the task mailbox: 403'));
    render(<TaskNotifySettings />);
    fireEvent.click(await screen.findByText('Check Mailbox Now'));
    expect(await screen.findByText(/Could not read the task mailbox/)).toBeTruthy();
  });
});

describe('replies log', () => {
  it('renders an empty log without crashing', async () => {
    await openReplies();
    expect(await screen.findByText(/Nothing has been received yet/)).toBeTruthy();
  });

  it('warns that nothing is being read while the switch is off', async () => {
    await openReplies();
    expect(await screen.findByText(/Replies are not being read right now/)).toBeTruthy();
  });

  it('shows why a reply was refused', async () => {
    // The reason column is the entire value of this screen: it is the answer to
    // "I replied and nothing happened".
    api.getTaskInboundLog.mockResolvedValue([{
      id: 'i1', taskId: 't1', commentId: '', from: 'outsider@evil.example',
      subject: 'Re: Fix the pump', status: 'rejected', matchedBy: 'address',
      reason: 'sender is not a known Nexus person', attachmentCount: 0,
      receivedAt: '2026-08-05T09:00:00Z', processedAt: '2026-08-05T09:01:00Z',
    }]);
    await openReplies();
    expect(await screen.findByText('sender is not a known Nexus person')).toBeTruthy();
    // "Refused" is also the filter's own option text, so match the row's label.
    expect(screen.getAllByText('Refused').some((el) => el.tagName !== 'OPTION')).toBe(true);
  });

  it('shows a posted reply with its attachment count', async () => {
    api.getTaskInboundLog.mockResolvedValue([{
      id: 'i2', taskId: 't1', commentId: 'c1', from: 'sagar.shoundik@greensglobal.com',
      subject: 'Re: Fix the pump', status: 'posted', matchedBy: 'address', reason: '',
      attachmentCount: 2, receivedAt: '2026-08-05T09:00:00Z', processedAt: '2026-08-05T09:01:00Z',
    }]);
    await openReplies();
    expect(await screen.findByText('Posted')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('names the task a reply landed on, and opens it on Comments', async () => {
    // The gap this closes: the row knew the task and the comment and showed
    // neither, so "where can I see this comment?" had no answer on screen.
    api.getTaskInboundLog.mockResolvedValue([{
      id: 'i4', taskId: 't1', commentId: 'c1', from: 'sagar.shoundik@greensglobal.com',
      subject: 'Re: pump seal', status: 'posted', matchedBy: 'address', reason: '',
      attachmentCount: 2, receivedAt: '2026-08-05T09:00:00Z', processedAt: '2026-08-05T09:01:00Z',
    }]);
    await openReplies();
    fireEvent.click(await screen.findByText('TASK-069'));
    expect(screen.getByTestId('drawer').textContent).toBe('drawer:t1:comments');
  });

  it('does not offer a dead click for a task it cannot resolve', async () => {
    api.getTaskInboundLog.mockResolvedValue([{
      id: 'i5', taskId: 'gone', commentId: '', from: 'x@greensglobal.com',
      subject: 'Re: deleted', status: 'posted', matchedBy: 'address', reason: '',
      attachmentCount: 0, receivedAt: '', processedAt: '',
    }]);
    await openReplies();
    fireEvent.click(await screen.findByText('—'));
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('renders a row whose sender or subject is missing', async () => {
    api.getTaskInboundLog.mockResolvedValue([{
      id: 'i3', taskId: '', commentId: '', from: '', subject: '', status: 'ignored',
      matchedBy: '', reason: 'automated mail', attachmentCount: 0,
      receivedAt: '', processedAt: '',
    }]);
    await openReplies();
    expect(await screen.findByText('unknown sender')).toBeTruthy();
    expect(screen.getByText('(no subject)')).toBeTruthy();
  });

  it('survives the log endpoint failing', async () => {
    api.getTaskInboundLog.mockRejectedValue(new Error('502'));
    await openReplies();
    await waitFor(() => expect(screen.getByText('502')).toBeTruthy());
  });
});
