// Render-smoke + behavior tests for the Announcements tile (Essentials, Oct 7).
// The tile sits on every saved dashboard, so a crash-on-render here would blank
// a board; each case mounts it against the real endpoint shapes (mocked).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getAnnouncements: vi.fn(), createAnnouncement: vi.fn(), updateAnnouncement: vi.fn(), deleteAnnouncement: vi.fn(),
  markAnnouncementRead: vi.fn(), ackAnnouncement: vi.fn(), getAnnouncementReads: vi.fn(),
}));
const role = vi.hoisted(() => ({ admin: false }));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', can: (r) => (r === 'administrator' ? role.admin : true) }) }));
vi.mock('../../ui/dialog.jsx', () => ({ dialog: { confirm: confirmMock, alert: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => false }));

import Announcements, { unreadCount, formOf } from './Announcements.jsx';

const ann = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2), title: 'Office closed Friday', body: 'Line one.\nLine two.\nLine three.',
  author_email: 'ada@greensglobal.com', author_name: 'Ada Admin', audience: 'company', department: '',
  pinned_until: '', pinned: false, requires_ack: false, created_at: '2026-10-07T15:00:00+00:00', updated_at: '',
  read_at: '', acknowledged_at: '', ...over,
});

beforeEach(() => {
  role.admin = false;
  apiMock.getAnnouncements.mockResolvedValue([]);
  apiMock.markAnnouncementRead.mockResolvedValue({});
  apiMock.ackAnnouncement.mockResolvedValue({});
  apiMock.createAnnouncement.mockResolvedValue({ id: 'new' });
  apiMock.updateAnnouncement.mockResolvedValue({});
  apiMock.deleteAnnouncement.mockResolvedValue({ ok: true });
  apiMock.getAnnouncementReads.mockResolvedValue([]);
  confirmMock.mockResolvedValue(true);
});
afterEach(() => { vi.clearAllMocks(); });

describe('Announcements tile', () => {
  it('shows the empty state without a Post button for an employee', async () => {
    render(<Announcements />);
    expect(await screen.findByText('No announcements.')).toBeTruthy();
    expect(screen.queryByText('Post')).toBeNull();
    expect(screen.queryByText('Post One')).toBeNull();
    expect(screen.getByText('0 unread')).toBeTruthy();
  });

  it('never renders blank when the load fails - a Retry button appears', async () => {
    apiMock.getAnnouncements.mockRejectedValueOnce(new Error('boom'));
    render(<Announcements />);
    expect(await screen.findByText('Could not load announcements.')).toBeTruthy();
    apiMock.getAnnouncements.mockResolvedValueOnce([ann({ title: 'Back' })]);
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByText('Back')).toBeTruthy();
  });

  it('lists in server order with the pinned row marked, unread titles bold and the unread count in the header', async () => {
    apiMock.getAnnouncements.mockResolvedValue([
      ann({ id: 'p', title: 'Pinned one', pinned: true, pinned_until: '2026-12-31', created_at: '2026-09-01T00:00:00+00:00' }),
      ann({ id: 'n', title: 'Newest', read_at: '2026-10-07T16:00:00+00:00' }),
    ]);
    render(<Announcements />);
    const titles = await screen.findAllByTestId('ann-title');
    expect(titles.map(t => t.textContent)).toEqual(['Pinned one', 'Newest']);
    expect(titles[0].style.fontWeight).toBe('700');   // unread
    expect(titles[1].style.fontWeight).toBe('500');   // read
    expect(screen.getByLabelText('Pinned')).toBeTruthy();
    expect(screen.getByText('Pinned until 12/31/2026')).toBeTruthy();
    expect(screen.getByText('1 unread')).toBeTruthy();
    expect(screen.getByText('Ada Admin - 10/07/2026')).toBeTruthy();
  });

  it('tapping a row expands the full body and marks it read once', async () => {
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'a1' })]);
    render(<Announcements />);
    const row = await screen.findByRole('button', { name: /Office closed Friday/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(apiMock.markAnnouncementRead).toHaveBeenCalledWith('a1');
    expect(screen.getByText('0 unread')).toBeTruthy();
    expect(screen.getByTestId('ann-title').style.fontWeight).toBe('500');
    fireEvent.click(row);   // collapse: already read, no second call
    expect(apiMock.markAnnouncementRead).toHaveBeenCalledTimes(1);
  });

  it('shows Acknowledge only while an acknowledgement is outstanding and records it', async () => {
    apiMock.getAnnouncements.mockResolvedValue([
      ann({ id: 'need', title: 'Policy update', requires_ack: true }),
      ann({ id: 'done', title: 'Already done', requires_ack: true, read_at: 'x', acknowledged_at: '2026-10-07T16:00:00+00:00' }),
      ann({ id: 'plain', title: 'Plain note' }),
    ]);
    render(<Announcements />);
    await screen.findByText('Policy update');
    expect(screen.getAllByText('Acknowledge')).toHaveLength(1);
    expect(screen.getAllByText('Acknowledged')).toHaveLength(1);
    fireEvent.click(screen.getByText('Acknowledge'));
    expect(apiMock.ackAnnouncement).toHaveBeenCalledWith('need');
    expect(apiMock.markAnnouncementRead).not.toHaveBeenCalled();   // the ack button does not toggle the row
    await waitFor(() => expect(screen.queryByText('Acknowledge')).toBeNull());
    expect(screen.getAllByText('Acknowledged')).toHaveLength(2);
    expect(screen.getByText('1 unread')).toBeTruthy();   // Plain note is still unread; the ack marked its own row read
  });

  it('caps the list at seven and View All opens the rest in place', async () => {
    apiMock.getAnnouncements.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ann({ id: `a${i}`, title: `Note ${i}` })));
    render(<Announcements />);
    await screen.findByText('Note 0');
    expect(screen.getAllByTestId('ann-title')).toHaveLength(7);
    fireEvent.click(screen.getByText(/View All \(9\)/));
    expect(screen.getAllByTestId('ann-title')).toHaveLength(9);
    fireEvent.click(screen.getByText(/Show Less/));
    expect(screen.getAllByTestId('ann-title')).toHaveLength(7);
  });

  it('lets an administrator post from the inline composer and refreshes the list', async () => {
    role.admin = true;
    render(<Announcements />);
    expect(await screen.findByText('No announcements.')).toBeTruthy();
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    fireEvent.click(within(form).getByText('Post Announcement'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Give the announcement a title.');
    expect(apiMock.createAnnouncement).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByPlaceholderText('What should people know?'), { target: { value: 'Parking lot closed' } });
    fireEvent.change(within(form).getByPlaceholderText('Plain text, line breaks are kept.'), { target: { value: 'Use the side street.' } });
    fireEvent.change(within(form).getByDisplayValue('Company'), { target: { value: 'department' } });
    fireEvent.change(within(form).getByPlaceholderText('e.g. Operations'), { target: { value: 'Operations' } });
    fireEvent.click(within(form).getByLabelText('Requires acknowledgement'));
    apiMock.getAnnouncements.mockResolvedValue([ann({ title: 'Parking lot closed', audience: 'department', department: 'Operations', read_count: 0, ack_count: 0, requires_ack: true })]);
    fireEvent.click(within(form).getByText('Post Announcement'));
    await waitFor(() => expect(apiMock.createAnnouncement).toHaveBeenCalledWith({
      title: 'Parking lot closed', body: 'Use the side street.', audience: 'department', department: 'Operations', pinned_until: '', requires_ack: true,
    }));
    expect(await screen.findByText('Parking lot closed')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(apiMock.getAnnouncements).toHaveBeenCalledTimes(2);
    // admin-only controls on the row
    expect(screen.getByText('Read by 0, acknowledged by 0')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('administrator Edit prefills the composer, Delete confirms first, Read by opens the receipts', async () => {
    role.admin = true;
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'e1', title: 'Old title', read_count: 2, ack_count: 0 })]);
    apiMock.getAnnouncementReads.mockResolvedValue([{ email: 'o@x.com', name: 'Oscar Ops', read_at: '2026-10-07T16:00:00+00:00', acknowledged_at: '' }]);
    render(<Announcements />);
    await screen.findByText('Old title');
    fireEvent.click(screen.getByText('Read by 2'));
    expect(await screen.findByText('Oscar Ops')).toBeTruthy();
    expect(apiMock.getAnnouncementReads).toHaveBeenCalledWith('e1');
    fireEvent.click(screen.getByText('Edit'));
    const form = screen.getByRole('form', { name: 'Edit Announcement' });
    expect(within(form).getByDisplayValue('Old title')).toBeTruthy();
    fireEvent.change(within(form).getByDisplayValue('Old title'), { target: { value: 'New title' } });
    fireEvent.click(within(form).getByText('Save Changes'));
    await waitFor(() => expect(apiMock.updateAnnouncement).toHaveBeenCalledWith('e1', expect.objectContaining({ title: 'New title' })));
    expect(apiMock.markAnnouncementRead).not.toHaveBeenCalled();   // Edit / Read by never toggle the row
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.deleteAnnouncement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(apiMock.deleteAnnouncement).toHaveBeenCalledWith('e1'));
    expect(await screen.findByText('No announcements.')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('unreadCount counts rows without a read mark', () => {
    expect(unreadCount([ann(), ann({ read_at: 'x' }), ann()])).toBe(2);
    expect(unreadCount(null)).toBe(0);
  });
  it('formOf maps a row onto the composer fields', () => {
    expect(formOf(ann({ audience: 'department', department: 'Ops', pinned_until: '2026-11-01', requires_ack: true })))
      .toEqual({ title: 'Office closed Friday', body: 'Line one.\nLine two.\nLine three.', audience: 'department', department: 'Ops', pinned_until: '2026-11-01', requires_ack: true });
    expect(formOf(null).audience).toBe('company');
  });
});
