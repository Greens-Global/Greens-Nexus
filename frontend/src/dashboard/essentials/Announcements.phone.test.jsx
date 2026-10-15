// Announcements tile at phone width: every tap target is at least 44px and
// the administrator's composer stacks its fields in one full-width column.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getAnnouncements: vi.fn(), createAnnouncement: vi.fn(), updateAnnouncement: vi.fn(), deleteAnnouncement: vi.fn(),
  markAnnouncementRead: vi.fn(), ackAnnouncement: vi.fn(), getAnnouncementReads: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', can: () => true }) }));
vi.mock('../../ui/dialog.jsx', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), alert: vi.fn() } }));
vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => true }));

import Announcements from './Announcements.jsx';

beforeEach(() => {
  apiMock.getAnnouncements.mockResolvedValue([{
    id: 'a1', title: 'Policy update', body: 'Read the new policy.', author_email: 'ada@x.com', author_name: 'Ada Admin',
    audience: 'company', department: '', pinned_until: '', pinned: false, requires_ack: true,
    created_at: '2026-10-07T15:00:00+00:00', updated_at: '', read_at: '', acknowledged_at: '', read_count: 0, ack_count: 0,
  }]);
  apiMock.markAnnouncementRead.mockResolvedValue({});
  apiMock.ackAnnouncement.mockResolvedValue({});
});

describe('Announcements tile on a phone', () => {
  it('gives the row, Acknowledge and Post 44px targets', async () => {
    render(<Announcements />);
    const row = await screen.findByRole('button', { name: /Policy update/ });
    expect(row.style.minHeight).toBe('44px');
    expect(screen.getByText('Acknowledge').style.minHeight).toBe('44px');
    expect(screen.getByText('Post').closest('button').style.minHeight).toBe('44px');
  });

  it('stacks the composer fields in one full-width column', async () => {
    render(<Announcements />);
    await screen.findByText('Policy update');
    fireEvent.click(screen.getByText('Post'));
    const form = screen.getByRole('form', { name: 'Post Announcement' });
    const audience = within(form).getByDisplayValue('Company');
    expect(audience.style.minHeight).toBe('44px');
    expect(audience.closest('label').parentElement.style.flexDirection).toBe('column');
    expect(form.style.padding).toBe('10px 0px 14px');
    expect(within(form).getByText('Post Announcement').style.minHeight).toBe('44px');
  });

  it('gives the admin links 36px targets, 16px fields, and wraps a long URL in the body', async () => {
    const url = 'https://example.com/' + 'x'.repeat(200);
    apiMock.getAnnouncements.mockResolvedValue([{
      id: 'a2', title: 'Link', body: url, author_email: 'ada@x.com', author_name: 'Ada Admin', audience: 'company',
      created_at: '2026-10-07T15:00:00+00:00', read_at: '2026-10-07T16:00:00+00:00', read_count: 3, ack_count: 0,
    }]);
    render(<Announcements />);
    fireEvent.click(await screen.findByRole('button', { name: /Link/ }));
    for (const text of ['Read by 3', 'Edit', 'Delete']) {
      expect(screen.getByText(text).closest('button').style.minHeight).toBe('36px');
    }
    expect(screen.getByText(url).style.overflowWrap).toBe('anywhere');
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      fireEvent.click(screen.getByText('Edit'));
      const form = screen.getByRole('form', { name: 'Edit Announcement' });
      expect(scroll).toHaveBeenCalled();                     // the form comes into view
      expect(within(form).getByDisplayValue('Link').style.fontSize).toBe('16px');
    } finally { delete Element.prototype.scrollIntoView; }
  });
});
