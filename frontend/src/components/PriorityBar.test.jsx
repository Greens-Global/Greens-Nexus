import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The priority bar (Neil, call of 09/29; adjusted 10/01): a notification
// with priority 1 sticks to the top until it is clicked off - opening the
// item does not clear it. Managers raise one from the bell's megaphone.

const markRead = vi.fn();
const dismiss = vi.fn();
let notifications = [];
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ notifications, markRead, dismiss }) }));
vi.mock('../contexts/RoleContext', () => ({ ROLES: { manager: { level: 3 }, employee: { level: 1 } }, useRole: () => ({ myEmail: 'me@greensglobal.com', myRole: 'manager' }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => e }));
vi.mock('../api', () => ({ api: {
  getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }]),
  sendPriorityNotice: vi.fn(async () => ({ id: 'n1' })),
} }));

vi.mock('./PersonHoverCard', () => ({ default: ({ children }) => children }));

import PriorityBar, { RaiseNotice, canRaiseNotice, noticeSummary } from './PriorityBar';
import { takePendingOpen } from '../lib/pendingOpen';
import { api } from '../api';

describe('PriorityBar', () => {
  it('shows the open priority notices, opens one without clearing it, closes one', async () => {
    notifications = [
      { id: 'a', priority: 1, read: false, actioned: false, title: 'Time Sheet to Review', body: 'Valinda, 09/01 - 09/30.', action: { view: 'hr', sub: 'hr-time', timecard: 'valinda.cranfill@greensstorage.com', start: '2026-09-01', payType: 'hourly' } },
      { id: 'b', priority: 1, read: true, actioned: false, title: 'Punch fix waiting', body: '', action: null },
      { id: 'c', priority: 0, read: false, actioned: false, title: 'Quiet bell item', body: '', action: null },
      { id: 'd', priority: 1, read: true, actioned: false, closed: true, title: 'Clicked off', body: '', action: null },
    ];
    const onNavigate = vi.fn();
    render(<PriorityBar onNavigate={onNavigate} />);
    const bar = screen.getByRole('alert', { name: 'Priority notice' });
    expect(bar.textContent).toContain('Time Sheet to Review');
    // A read-but-not-closed notice still counts; a closed one is gone.
    expect(bar.textContent).toContain('1 of 2');
    expect(screen.queryByText('Quiet bell item')).toBeNull();
    expect(screen.queryByText('Clicked off')).toBeNull();
    const opened = vi.fn();
    window.addEventListener('nexus:open-timecard', (e) => opened(e.detail));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onNavigate).toHaveBeenCalledWith('hr', 'hr-time');
    expect(markRead).toHaveBeenCalledWith('a');
    // Opening clears the notice (Neil, 10/08): it goes to the bell's Closed
    // list the same way the X does. (The mock keeps it in the list, so the
    // bar still shows it here - the dismiss call is what matters.)
    expect(dismiss).toHaveBeenCalledWith('a');
    // The person the notice names is handed to the Time screen, so it opens on THEIR timecard.
    await waitFor(() => expect(opened).toHaveBeenCalledWith({ email: 'valinda.cranfill@greensstorage.com', start: '2026-09-01', payType: 'hourly' }));
    // The pending note waits for a Time screen that is still loading.
    expect(takePendingOpen('timecard')).toEqual({ email: 'valinda.cranfill@greensstorage.com', start: '2026-09-01', payType: 'hourly' });
    dismiss.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(dismiss).toHaveBeenCalledWith('b');
  });

  it('Show All lists every notice, then Clear All closes them all (Pranshu, Oct 16)', () => {
    notifications = [
      { id: 'a', priority: 1, read: false, actioned: false, title: 'Sign your time sheet', body: '', action: { view: 'timeclock' } },
      { id: 'b', priority: 1, read: false, actioned: false, title: 'Time-off request', body: '', action: { view: 'hr' } },
    ];
    dismiss.mockClear();
    render(<PriorityBar />);
    expect(screen.queryByText('Time-off request')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show All' }));
    const list = within(screen.getByRole('dialog', { name: 'All priority notices' }));
    expect(list.getByText('Sign your time sheet')).toBeTruthy();
    expect(list.getByText('Time-off request')).toBeTruthy();
    expect(list.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Show All' })).toBeNull();
    fireEvent.click(list.getByRole('button', { name: 'Clear All' }));
    expect(dismiss.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('keeps the bar to a headline - the reason is read in the details layer (Neil, Oct 17)', () => {
    notifications = [{ id: 'a', priority: 1, read: false, actioned: false, title: 'Time Sheet Fix Requested',
      body: 'Nick Vaca asked to add a break end punch at 1:30 PM on 10/15/2026.\nReason: I clocked out instead of ending my break', action: { view: 'hr' } }];
    render(<PriorityBar />);
    const bar = screen.getByRole('alert', { name: 'Priority notice' });
    expect(bar.textContent).toContain('Nick Vaca asked to add a break end punch at 1:30 PM on 10/15/2026.');
    expect(bar.textContent).not.toContain('Reason');
    fireEvent.click(screen.getByRole('button', { name: 'Read the full notice: Time Sheet Fix Requested' }));
    const sheet = screen.getByRole('dialog', { name: 'Priority notice details' });
    expect(sheet.textContent).toContain('Reason: I clocked out instead of ending my break');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close Notice' }));
    expect(dismiss).toHaveBeenCalledWith('a');
  });

  it('summarizes a one-line body at its first sentence', () => {
    expect(noticeSummary('Dan asked to add a punch on 10/15/2026. Reason: forgot')).toBe('Dan asked to add a punch on 10/15/2026.');
    expect(noticeSummary('Valinda, 09/01 - 09/30.')).toBe('Valinda, 09/01 - 09/30.');
    expect(noticeSummary('')).toBe('');
  });

  it('has no Show All for a single notice', () => {
    notifications = [{ id: 'a', priority: 1, read: false, actioned: false, title: 'Owed', body: '', action: { view: 'hr' } }];
    render(<PriorityBar />);
    expect(screen.queryByRole('button', { name: 'Show All' })).toBeNull();
  });

  it('sticks to the top and shows nothing when nothing is owed', () => {
    notifications = [{ id: 'a', priority: 1, read: false, actioned: false, title: 'Owed', body: '', action: null }];
    const { unmount } = render(<PriorityBar />);
    expect(screen.getByRole('alert', { name: 'Priority notice' }).style.position).toBe('sticky');
    unmount();
    notifications = [];
    const { container } = render(<PriorityBar />);
    expect(container.innerHTML).toBe('');
  });

  it('lets a manager raise a notice for a person', async () => {
    expect(canRaiseNotice('manager')).toBe(true);
    expect(canRaiseNotice('employee')).toBe(false);
    render(<RaiseNotice onClose={() => {}} myEmail="me@greensglobal.com" />);
    // To is the Tasks people picker: open, type, pick.
    fireEvent.click(await screen.findByLabelText('To'));
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'urm' } });
    fireEvent.click(await within(screen.getByRole('listbox')).findByText('Urmi Gor'));
    expect(screen.getByLabelText('To').textContent).toContain('Urmi Gor');
    fireEvent.change(screen.getByLabelText('What must be done'), { target: { value: 'Sign your time sheet by 5 PM' } });
    fireEvent.change(screen.getByLabelText('Open takes them to'), { target: { value: 'timeclock:timecard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Notice' }));
    await waitFor(() => expect(api.sendPriorityNotice).toHaveBeenCalled());
    expect(api.sendPriorityNotice.mock.calls[0][0]).toMatchObject({ recipient: 'urmi.gor@greensglobal.com', title: 'Sign your time sheet by 5 PM', action: { view: 'timeclock', sub: 'timecard' } });
  });
});
