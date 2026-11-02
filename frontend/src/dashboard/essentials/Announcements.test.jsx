// Render-smoke + behavior tests for the Announcements tile (Essentials, Oct 7).
// The tile sits on every saved dashboard, so a crash-on-render here would blank
// a board; each case mounts it against the real endpoint shapes (mocked).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getAnnouncements: vi.fn(), createAnnouncement: vi.fn(), updateAnnouncement: vi.fn(), deleteAnnouncement: vi.fn(),
  markAnnouncementRead: vi.fn(), ackAnnouncement: vi.fn(), getAnnouncementReads: vi.fn(), getWorkSites: vi.fn(),
}));
const role = vi.hoisted(() => ({ admin: false }));
const confirmMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: apiMock }));
// The uploader is the Tasks module's (private task-files bucket); here it only
// has to hand back a URL. The paste helper stays real.
vi.mock('../../tasks/lib', async (orig) => ({ ...(await orig()), storeTaskFile: uploadMock }));
// DateField opens a calendar popover; a plain box keeps the publish-later
// path testable. TimeField (the 12-hour select) stays real.
vi.mock('../../tasks/components', async (orig) => ({
  ...(await orig()),
  DateField: ({ value, onChange, title }) => <input aria-label={title} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', can: (r) => (r === 'administrator' ? role.admin : true) }) }));
vi.mock('../../ui/dialog.jsx', () => ({ dialog: { confirm: confirmMock, alert: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => false }));

import Announcements, { unreadCount, formOf, ackSummary, joinLocal, splitLocal } from './Announcements.jsx';

const ann = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2), title: 'Office closed Friday', body: 'Line one.\nLine two.\nLine three.',
  author_email: 'ada@greensglobal.com', author_name: 'Ada Admin', audience: 'company', department: '',
  pinned_until: '', pinned: false, requires_ack: false, created_at: '2026-10-07T15:00:00+00:00', updated_at: '',
  read_at: '', acknowledged_at: '', image_url: '', file_url: '', file_name: '', publish_at: '', notify: 'quiet', notified_at: '2026-10-07T15:00:00+00:00', scheduled: false, ...over,
});
const STORAGE = 'https://x.supabase.co/storage/v1/object/public/task-files/announcements/new/pic.png';

beforeEach(() => {
  role.admin = false;
  apiMock.getAnnouncements.mockResolvedValue([]);
  apiMock.markAnnouncementRead.mockResolvedValue({});
  apiMock.ackAnnouncement.mockResolvedValue({});
  apiMock.createAnnouncement.mockResolvedValue({ id: 'new' });
  apiMock.updateAnnouncement.mockResolvedValue({});
  apiMock.deleteAnnouncement.mockResolvedValue({ ok: true });
  apiMock.getAnnouncementReads.mockResolvedValue({ reads: [] });
  apiMock.getWorkSites.mockResolvedValue([{ id: 's-yard', name: 'North Yard' }, { id: 's-depot', name: 'Depot' }]);
  confirmMock.mockResolvedValue(true);
  uploadMock.mockResolvedValue(STORAGE);
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
    // The refetch after the ack lands returns the server's view: acknowledged, with counts moved.
    apiMock.getAnnouncements.mockResolvedValue([
      ann({ id: 'need', title: 'Policy update', requires_ack: true, read_at: 'y', acknowledged_at: '2026-10-08T16:00:00+00:00', read_count: 1, ack_count: 1 }),
      ann({ id: 'done', title: 'Already done', requires_ack: true, read_at: 'x', acknowledged_at: '2026-10-07T16:00:00+00:00' }),
      ann({ id: 'plain', title: 'Plain note' }),
    ]);
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
    fireEvent.click(within(form).getByLabelText('Requires Acknowledgment'));
    apiMock.getAnnouncements.mockResolvedValue([ann({ title: 'Parking lot closed', audience: 'department', department: 'Operations', read_count: 0, ack_count: 0, requires_ack: true })]);
    fireEvent.click(within(form).getByText('Post Announcement'));
    await waitFor(() => expect(apiMock.createAnnouncement).toHaveBeenCalledWith({
      title: 'Parking lot closed', body: 'Use the side street.', audience: 'department', department: 'Operations', work_site_id: '', pinned_until: '', requires_ack: true,
      image_url: '', file_url: '', file_name: '', notify: 'quiet', publish_at: '',
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
      .toEqual({ title: 'Office closed Friday', body: 'Line one.\nLine two.\nLine three.', audience: 'department', department: 'Ops', work_site_id: '', pinned_until: '2026-11-01', requires_ack: true,
        image_url: '', file_url: '', file_name: '', publish_at: '', notify: 'quiet' });
    expect(formOf(null).audience).toBe('company');
    expect(formOf(ann({ notify: 'bogus' })).notify).toBe('quiet');
  });
  it('ackSummary names the first acknowledgers and counts the rest', () => {
    expect(ackSummary(ann({ ack_count: 0, ack_names: [] }))).toBe('');
    expect(ackSummary(ann({ ack_count: 1, ack_names: ['Ana Diaz'] }))).toBe('Acknowledged by Ana Diaz');
    expect(ackSummary(ann({ ack_count: 5, ack_names: ['Ana Diaz', 'Bob Lee'] }))).toBe('Acknowledged by Ana Diaz, Bob Lee and 3 more');
    expect(ackSummary(ann({ ack_count: 2 }))).toBe('Acknowledged by 2');
    // Exactly two acknowledgers (the server sends two names): "and", no comma.
    expect(ackSummary(ann({ ack_count: 2, ack_names: ['Ana Diaz', 'Bob Lee'] }))).toBe('Acknowledged by Ana Diaz and Bob Lee');
    expect(ackSummary(ann({ ack_count: 3, ack_names: ['Ana Diaz', 'Bob Lee'] }))).toBe('Acknowledged by Ana Diaz, Bob Lee and 1 more');
  });
  it('joinLocal / splitLocal round-trip a local date and time through an ISO instant', () => {
    const iso = joinLocal('2026-11-05', '09:30');
    expect(iso).toMatch(/Z$/);
    expect(splitLocal(iso)).toEqual({ date: '2026-11-05', time: '09:30' });
    expect(joinLocal('2026-11-05', '')).toBe('');
    expect(joinLocal('', '09:30')).toBe('');
    expect(splitLocal('')).toEqual({ date: '', time: '' });
  });
});

describe('Announcements reach (11/02/2026)', () => {
  it('shows the picture when expanded and the file link always, through the viewer', async () => {
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'm', title: 'New signage', image_url: STORAGE, file_url: STORAGE.replace('pic.png', 'plan.pdf'), file_name: 'plan.pdf' })]);
    render(<Announcements />);
    const row = await screen.findByRole('button', { name: /New signage/ });
    expect(screen.queryByTestId('ann-image')).toBeNull();
    expect(screen.getByText('Picture')).toBeTruthy();
    const link = screen.getByText('plan.pdf').closest('a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toContain('plan.pdf');
    fireEvent.click(link);
    expect(apiMock.markAnnouncementRead).not.toHaveBeenCalled();   // the link never toggles the row
    fireEvent.click(row);
    expect(screen.getByTestId('ann-image').getAttribute('src')).toContain('pic.png');
  });

  it('the picture is content (a real alt), the row is dated by when it published, and the Notify options say Bell', async () => {
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'd', title: 'Diwali hours', image_url: STORAGE, created_at: '2026-10-01T15:00:00+00:00', shown_at: '2026-10-20T15:00:00+00:00' })]);
    role.admin = true;
    render(<Announcements />);
    const row = await screen.findByRole('button', { name: /Diwali hours/ });
    expect(screen.getByText(/10\/20\/2026/)).toBeTruthy();
    expect(screen.queryByText(/10\/01\/2026/)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByTestId('ann-image').getAttribute('alt')).toBe('Picture for Diwali hours');
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    const labels = Array.from(within(form).getByLabelText('Notify').options).map((o) => o.textContent);
    expect(labels).toEqual(['Bell', 'Bell and Teams', 'Bell and Email']);
    expect(within(form).getByText(/phone notification if they installed Nexus/)).toBeTruthy();
    expect(within(form).queryByText(/Push/)).toBeNull();
  });

  it('a picture over 10 MB or a file over 25 MB is refused in a sentence before any upload starts', async () => {
    role.admin = true;
    render(<Announcements />);
    await screen.findByText('No announcements.');
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(within(form).getByLabelText('Picture file'), { target: { files: [big] } });
    expect(await within(form).findByRole('alert')).toHaveTextContent('That picture is larger than 10 MB.');
    const bigFile = new File(['x'], 'plans.pdf', { type: 'application/pdf' });
    Object.defineProperty(bigFile, 'size', { value: 26 * 1024 * 1024 });
    fireEvent.change(within(form).getByLabelText('Attachment file'), { target: { files: [bigFile] } });
    expect(await within(form).findByRole('alert')).toHaveTextContent('That file is larger than 25 MB.');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('an administrator sees Scheduled for and the acknowledged-by names; staff see neither', async () => {
    const rows = [ann({ id: 's', title: 'Holiday hours', publish_at: '2026-11-20T17:00:00+00:00', notified_at: '', scheduled: true, requires_ack: true, read_count: 3, ack_count: 4, ack_names: ['Ana Diaz', 'Bob Lee'] })];
    apiMock.getAnnouncements.mockResolvedValue(rows);
    const { unmount } = render(<Announcements />);
    await screen.findByText('Holiday hours');
    expect(screen.queryByText(/Scheduled for/)).toBeNull();
    expect(screen.queryByTestId('ann-acks')).toBeNull();
    unmount();
    role.admin = true;
    render(<Announcements />);
    await screen.findByText('Holiday hours');
    expect(screen.getByText(/Scheduled for 11\/20\/2026/)).toBeTruthy();
    expect(screen.getByTestId('ann-acks').textContent).toBe('Acknowledged by Ana Diaz, Bob Lee and 2 more');
    expect(screen.getByText('Read by 3')).toBeTruthy();   // the count moved into the names line
  });

  it('Publish Later and Notify travel with the post; Ctrl+V in the body uploads a picture', async () => {
    role.admin = true;
    render(<Announcements />);
    await screen.findByText('No announcements.');
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    fireEvent.change(within(form).getByPlaceholderText('What should people know?'), { target: { value: 'Town hall' } });
    const body = within(form).getByPlaceholderText('Plain text, line breaks are kept.');
    fireEvent.change(body, { target: { value: 'Friday at noon.' } });
    // Paste a picture: the uploader runs and the preview appears.
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(body, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    expect(await within(form).findByTestId('ann-image-preview')).toBeTruthy();
    expect(uploadMock).toHaveBeenCalledWith(file, expect.any(Function), 'announcements/new', expect.any(Number));
    expect(within(form).queryByText(/press Ctrl\+V/)).toBeNull();
    // Notify + Publish Later.
    fireEvent.change(within(form).getByLabelText('Notify'), { target: { value: 'push_teams' } });
    fireEvent.click(within(form).getByLabelText('Publish Later'));
    fireEvent.click(within(form).getByText('Schedule Announcement'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Pick the date and time to publish.');
    fireEvent.change(within(form).getByLabelText('Publish date'), { target: { value: '2099-01-05' } });
    fireEvent.change(within(form).getByLabelText('Publish time'), { target: { value: '09:30' } });
    fireEvent.click(within(form).getByText('Schedule Announcement'));
    await waitFor(() => expect(apiMock.createAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Town hall', notify: 'push_teams', image_url: STORAGE, publish_at: joinLocal('2099-01-05', '09:30'),
    })));
  });

  it('editing a published post keeps its publish time out of the payload and shows when it went out', async () => {
    role.admin = true;
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'p1', title: 'Went out', notified_at: '2026-10-07T15:00:00+00:00', read_count: 0, ack_count: 0 })]);
    render(<Announcements />);
    await screen.findByText('Went out');
    fireEvent.click(screen.getByText('Edit'));
    const form = screen.getByRole('form', { name: 'Edit Announcement' });
    expect(within(form).queryByLabelText('Publish Later')).toBeNull();
    expect(within(form).getByText('Published')).toBeTruthy();
    fireEvent.click(within(form).getByText('Save Changes'));
    await waitFor(() => expect(apiMock.updateAnnouncement).toHaveBeenCalled());
    expect(apiMock.updateAnnouncement.mock.calls[0][1]).not.toHaveProperty('publish_at');
  });

  // Work site audience + not yet acknowledged (Neil, 11/02/2026).
  it('the composer offers Work Site and a site picker from the work-site library; the site travels with the post', async () => {
    role.admin = true;
    render(<Announcements />);
    await screen.findByText('No announcements.');
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    const audience = within(form).getByLabelText('Audience');
    expect(Array.from(audience.options).map((o) => o.textContent)).toEqual(['Company', 'Department', 'Work Site']);
    expect(within(form).queryByLabelText('Work Site')).toBeNull();
    fireEvent.change(audience, { target: { value: 'site' } });
    const picker = await within(form).findByLabelText('Work Site');
    await waitFor(() => expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['Pick a site', 'North Yard', 'Depot']));
    expect(apiMock.getWorkSites).toHaveBeenCalled();
    fireEvent.change(within(form).getByPlaceholderText('What should people know?'), { target: { value: 'Gate code' } });
    fireEvent.change(within(form).getByPlaceholderText('Plain text, line breaks are kept.'), { target: { value: 'New code Monday.' } });
    fireEvent.click(within(form).getByText('Post Announcement'));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Pick the work site.');
    expect(apiMock.createAnnouncement).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { value: 's-yard' } });
    fireEvent.click(within(form).getByText('Post Announcement'));
    await waitFor(() => expect(apiMock.createAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      audience: 'site', work_site_id: 's-yard', department: '',
    })));
  });

  it('a site post carries its site name as the row chip and formOf keeps the site for Edit', async () => {
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'y', title: 'Yard gate', audience: 'site', workSiteId: 's-yard', workSiteName: 'North Yard' })]);
    render(<Announcements />);
    await screen.findByText('Yard gate');
    expect(screen.getByText('North Yard')).toBeTruthy();
    expect(formOf({ audience: 'site', workSiteId: 's-yard' })).toMatchObject({ audience: 'site', work_site_id: 's-yard' });
    expect(formOf({ audience: 'company' }).work_site_id).toBe('');
  });

  it('Read by opens the list with who has not yet acknowledged; a plain list answer still renders', async () => {
    role.admin = true;
    apiMock.getAnnouncements.mockResolvedValue([ann({ id: 'k', title: 'Safety rule', requires_ack: true, read_count: 1, ack_count: 1 })]);
    apiMock.getAnnouncementReads.mockResolvedValue({
      reads: [{ email: 'ana@greensglobal.com', name: 'Ana Diaz', read_at: '2026-11-02T15:00:00+00:00', acknowledged_at: '2026-11-02T15:00:00+00:00' }],
      notAcknowledged: [{ email: 'bob@greensglobal.com', name: 'Bob Lee' }, { email: 'cy@greensglobal.com', name: 'Cy Ng' }],
    });
    const { unmount } = render(<Announcements />);
    await screen.findByText('Safety rule');
    fireEvent.click(screen.getByText(/^Read by 1/));
    expect(await screen.findByText('Ana Diaz')).toBeTruthy();
    expect(screen.getByText('Not Yet Acknowledged (2)')).toBeTruthy();
    expect(screen.getByText('Bob Lee, Cy Ng')).toBeTruthy();
    unmount();
    apiMock.getAnnouncementReads.mockResolvedValue({
      reads: [{ email: 'ana@greensglobal.com', name: 'Ana Diaz', read_at: '2026-11-02T15:00:00+00:00', acknowledged_at: '2026-11-02T15:00:00+00:00' }],
      notAcknowledged: [],
    });
    const second = render(<Announcements />);
    await screen.findByText('Safety rule');
    fireEvent.click(screen.getByText(/^Read by 1/));
    expect(await screen.findByText('Everyone Has Acknowledged')).toBeTruthy();   // Title Case, like a status label
    second.unmount();
    apiMock.getAnnouncementReads.mockResolvedValue([{ email: 'ana@greensglobal.com', name: 'Ana Diaz', read_at: '2026-11-02T15:00:00+00:00', acknowledged_at: '' }]);
    render(<Announcements />);
    await screen.findByText('Safety rule');
    fireEvent.click(screen.getByText(/^Read by 1/));
    expect(await screen.findByText('Ana Diaz')).toBeTruthy();
    expect(screen.queryByText(/Not Yet Acknowledged/)).toBeNull();
  });
});
