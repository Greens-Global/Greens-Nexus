import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// What's New on a phone (Neil, Oct 12 2026): it should look great and work.
// useIsMobile is forced on; everything else is the real component.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myEmail: 'admin@greensglobal.com', can: () => true }),
}));
vi.mock('./components', async (importOriginal) => ({ ...(await importOriginal()), useIsMobile: () => true }));

import { api } from '../api';
import Changelog from './ChangelogView';

const entry = (id, title, extra = {}) => ({
  id, title, description: 'Plain words.', type: 'Bug Fix', module: 'Tasks', status: 'Released',
  releasedAt: '2026-10-09T10:00:00Z', authorId: 'admin@greensglobal.com', version: 'v1.0.0', ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskChangelog.mockResolvedValue([entry('e1', 'First fix'), entry('e2', 'Second fix'),
    entry('e3', 'Waiting one', { status: 'Pending Review' })]);
  api.getTaskChangelogAutoStatus.mockResolvedValue({ enabled: false });
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([]);
});

describe("What's New on a phone", () => {
  it('has a compact header and tabs that fit: short labels, no icons', async () => {
    render(<Changelog />);
    await screen.findByText('First fix');
    expect(screen.getByRole('button', { name: 'Add New Update' }).textContent).toBe('Add');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(["What's New", 'Timeline', 'Versions', 'Manage1']);
    expect(tabs[0].querySelector('svg')).toBeNull();
  });

  it('drops the empty screenshot box and gives View Full Details a real button', async () => {
    render(<Changelog />);
    await screen.findByText('First fix');
    expect(document.querySelectorAll('[data-whats-new-row] .lucide-image').length).toBe(0);
    const view = screen.getAllByRole('button', { name: /View Full Details/ })[0];
    expect(view.style.width).toBe('100%');
  });

  it('Timeline is one list; a tapped row opens a full-screen sheet with a Close button', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('Select an update to see details.')).toBeNull();   // no side pane
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Second fix/ }));
    const close = await screen.findByRole('button', { name: 'Close' });
    expect(screen.queryByTitle('Expand to full page')).toBeNull();               // already full screen
    fireEvent.click(close);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('Manage rows keep labelled 40px edit and delete targets', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('tab', { name: /Manage/ }));
    const edit = await screen.findByRole('button', { name: 'Edit First fix' });
    expect(edit.style.width).toBe('40px');
    expect(within(edit.parentElement).getByRole('button', { name: 'Delete First fix' })).toBeTruthy();
  });
});
