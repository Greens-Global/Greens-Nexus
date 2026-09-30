import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The priority bar (Neil, call of 09/29): a notification with priority 1
// sits across the top until it is opened or marked done; managers raise one.

const markRead = vi.fn();
let notifications = [];
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ notifications, markRead }) }));
vi.mock('../contexts/RoleContext', () => ({ ROLES: { manager: { level: 3 }, employee: { level: 1 } }, useRole: () => ({ myEmail: 'me@greensglobal.com', myRole: 'manager' }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => e }));
vi.mock('../api', () => ({ api: {
  getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }]),
  sendPriorityNotice: vi.fn(async () => ({ id: 'n1' })),
} }));

import PriorityBar from './PriorityBar';
import { api } from '../api';

describe('PriorityBar', () => {
  it('shows the open priority notices, opens one, marks one done', () => {
    notifications = [
      { id: 'a', priority: 1, read: false, actioned: false, title: 'Sign your timecard', body: 'Due tomorrow.', action: { view: 'timeclock', sub: 'timecard' } },
      { id: 'b', priority: 1, read: false, actioned: false, title: 'Timesheet to review', body: '', action: null },
      { id: 'c', priority: 0, read: false, actioned: false, title: 'Quiet bell item', body: '', action: null },
      { id: 'd', priority: 1, read: true, actioned: false, title: 'Already done', body: '', action: null },
    ];
    const onNavigate = vi.fn();
    render(<PriorityBar onNavigate={onNavigate} />);
    const bar = screen.getByRole('alert', { name: 'Priority notice' });
    expect(bar.textContent).toContain('Sign your timecard');
    expect(bar.textContent).toContain('1 of 2');
    expect(screen.queryByText('Quiet bell item')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onNavigate).toHaveBeenCalledWith('timeclock', 'timecard');
    expect(markRead).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(markRead).toHaveBeenCalledWith('b');
  });

  it('lets a manager raise a notice for a person', async () => {
    notifications = [];
    render(<PriorityBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Raise a priority notice' }));
    const to = await screen.findByLabelText('To');
    await waitFor(() => expect(to.options.length).toBe(2));
    fireEvent.change(to, { target: { value: 'urmi.gor@greensglobal.com' } });
    fireEvent.change(screen.getByLabelText('What must be done'), { target: { value: 'Sign your timecard by 5 PM' } });
    fireEvent.change(screen.getByLabelText('Open takes them to'), { target: { value: 'timeclock:timecard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Notice' }));
    await waitFor(() => expect(api.sendPriorityNotice).toHaveBeenCalled());
    expect(api.sendPriorityNotice.mock.calls[0][0]).toMatchObject({ recipient: 'urmi.gor@greensglobal.com', title: 'Sign your timecard by 5 PM', action: { view: 'timeclock', sub: 'timecard' } });
  });
});
