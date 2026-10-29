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
  MODULES: [{ id: 'tickets', label: 'Tickets' }, { id: 'tasks', label: 'Tasks' }],
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
    // Version History is part of the Timeline, Manage a header button (Oct 16 2026).
    expect(tabs.map((t) => t.textContent)).toEqual(['Latest', 'Timeline']);
    expect(screen.getByRole('button', { name: 'Manage' }).textContent).toBe('Manage1');
    expect(tabs[0].querySelector('svg')).toBeNull();
  });

  it('drops the empty screenshot box and gives View Full Details a real button', async () => {
    render(<Changelog />);
    await screen.findByText('First fix');
    expect(document.querySelectorAll('[data-whats-new-row] .lucide-image').length).toBe(0);
    const view = screen.getAllByRole('button', { name: /View Full Details/ })[0];
    expect(view.style.width).toBe('100%');
  });

  // The Timeline's phone pass (Neil, Oct 28 2026: "the mobile UI and UX on
  // that sucks").
  it('Timeline is one list behind a search box and one Filter button; a tapped row opens its own screen with Back', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('Select an update to see details.')).toBeNull();   // no side pane
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.queryByLabelText('Module')).toBeNull();                        // no inline filter bar
    expect(screen.queryByText('Copy Link to This View')).toBeNull();
    expect(screen.getByLabelText('Search updates').style.fontSize).toBe('16px'); // no iOS zoom-in
    // Each day's header stays pinned while you scroll through it.
    expect(document.querySelector('[data-day-header]').style.position).toBe('sticky');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Second fix/ }));
    const screenOf = await screen.findByRole('dialog', { name: 'Second fix' });
    const back = within(screenOf).getByRole('button', { name: 'Back' });
    expect(screen.queryByTitle('Expand to full page')).toBeNull();               // already full screen
    fireEvent.click(back);
    expect(screen.queryByRole('dialog', { name: 'Second fix' })).toBeNull();
  });

  it('Filter opens a sheet; a picked filter shows as a chip you can take off', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filter Updates' });
    fireEvent.change(within(sheet).getByLabelText('Category'), { target: { value: 'New Feature' } });
    expect(within(sheet).getByRole('button', { name: 'No Matching Updates' })).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Category'), { target: { value: 'Bug Fix' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 2 Updates' }));
    expect(screen.queryByRole('dialog', { name: 'Filter Updates' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter (1 on)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Bug Fix' }));
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
  });

  it("an admin's actions sit behind More, not in a row that runs off the screen", async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    fireEvent.click(screen.getByRole('button', { name: /First fix/ }));
    const screenOf = await screen.findByRole('dialog', { name: 'First fix' });
    expect(within(screenOf).queryByRole('button', { name: /Report Issue/ })).toBeNull();
    fireEvent.click(within(screenOf).getByRole('button', { name: 'More Actions' }));
    const actions = await screen.findByRole('dialog', { name: 'Update Actions' });
    expect(within(actions).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Report Issue' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Released' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Feature Request and Follow sit in the tab strip, not a row of their own', async () => {
    render(<Changelog />);
    await screen.findByText('First fix');
    const strip = screen.getByRole('tablist').parentElement;
    expect(within(strip).getByRole('button', { name: 'Feature Request' })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: 'Follow' })).toBeTruthy();
  });

  it('Manage rows keep labelled 40px edit and delete targets', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    const edit = await screen.findByRole('button', { name: 'Edit First fix' });
    expect(edit.style.width).toBe('40px');
    expect(within(edit.parentElement).getByRole('button', { name: 'Delete First fix' })).toBeTruthy();
  });
});
