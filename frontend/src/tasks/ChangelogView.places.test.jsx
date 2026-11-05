import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// What's New Timeline (Neil, 11/04/2026): the Module filter follows the site's
// navigation (a section, then its pages, with counts), every row names its
// pull request, and the bar between the list and the detail resizes them.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
    recordTaskChangelogViews: vi.fn(), getTaskChangelogMe: vi.fn(), getTaskChangelogAnalytics: vi.fn(),
    getTaskChangelogFeedback: vi.fn(), getTaskChangelogHints: vi.fn(), getTaskChangelogHistory: vi.fn(),
    getTaskChangelogEntryAnalytics: vi.fn(),
  },
}));
// Photos keyed by work email - a row's developer avatar reads from here.
vi.mock('../lib/peoplePhotos', () => ({
  usePhotoMap: () => ({ 'pranshu.pandey@greensglobal.com': 'https://example.test/pranshu.jpg' }),
}));
vi.mock('../contexts/RoleContext', () => ({
  MODULES: [{ id: 'tickets', label: 'Tickets' }, { id: 'myhr', label: 'Workday' }],
  useRole: () => ({ myEmail: 'amy@greensglobal.com', can: () => false, myGrantedModules: new Map() }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';

const at = (h) => new Date(2026, 10, 3, h, 0).toISOString();
const rel = (id, title, module, extra = {}) => ({
  id, title, description: 'Plain words.', type: 'Bug Fix', module, status: 'Released', releasedAt: at(10),
  reactions: {}, myReactions: [], commentCount: 0, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* no storage */ }
  window.history.replaceState(null, '', '/whats-new?tab=timeline');
  api.getTaskChangelog.mockResolvedValue([
    rel('a', 'Clock Thing', 'Workday', { environment: 'Production', prNumber: 990, prRef: '#990', prUrl: 'https://github.com/Greens-Global/Greens-Nexus/pull/990' }),
    rel('b', 'Sheet Thing', 'Time Sheet', { releasedAt: at(9) }),
    rel('c', 'Review Thing', 'Time Sheets to Review', { releasedAt: at(8) }),
    rel('d', 'Approvals Thing', 'Dashboard > Approvals', { releasedAt: at(7) }),
  ]);
  api.getTaskChangelogMe.mockResolvedValue({ sinceAt: '', subscription: { modules: [], categories: [], digest: false } });
  api.getTaskChangelogAutoStatus.mockResolvedValue({ enabled: true });
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.recordTaskChangelogViews.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([]);
  api.getTaskChangelogAnalytics.mockResolvedValue({ totals: {}, entries: {} });
  api.getTaskChangelogFeedback.mockResolvedValue({ yes: 0, no: 0, mine: null });
  api.getTaskChangelogHistory?.mockResolvedValue?.([]);
});

describe('Timeline places', () => {
  it('lists the sections in navigation order with their pages and counts; several modules filter together', async () => {
    render(<Changelog />);
    await screen.findAllByText('Sheet Thing');
    const group = screen.getByRole('group', { name: 'Module' });
    fireEvent.click(within(group).getAllByRole('button')[0]);
    const options = [...document.querySelectorAll('.nx-menu-row')].map((o) => o.textContent);
    expect(options).toEqual([
      'Dashboard (1)', 'Dashboard - Approvals (1)', 'Workday (2)', 'Workday - Time Sheet (1)',
      'People (1)', 'People - Time (1)',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Workday (2)' }));       // a section takes in its pages
    expect(screen.getAllByText('Sheet Thing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Clock Thing').length).toBeGreaterThan(0);
    expect(screen.queryByText('Review Thing')).toBeNull();
    expect(screen.queryByText('Approvals Thing')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('module')).toBe('myhr');
    fireEvent.click(screen.getByRole('option', { name: 'Dashboard (1)' }));    // a second module adds to it
    expect(screen.getAllByText('Approvals Thing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Clock Thing').length).toBeGreaterThan(0);
    expect(screen.queryByText('Review Thing')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('module')).toBe('myhr,dashboard');
    fireEvent.click(screen.getByRole('option', { name: 'Workday (2)' }));       // and comes off again
    fireEvent.click(screen.getByRole('option', { name: 'Dashboard (1)' }));
    expect(screen.getAllByText('Review Thing').length).toBeGreaterThan(0);      // none picked = All
    expect(window.location.search).not.toContain('module=');
  });

  it('a shared link with an old module name, or several modules, still filters', async () => {
    window.history.replaceState(null, '', '/whats-new?tab=timeline&module=Time%20Sheets%20to%20Review');
    const { unmount } = render(<Changelog />);
    await screen.findAllByText('Review Thing');
    expect(within(screen.getByRole('group', { name: 'Module' })).getByText('People - Time (1)')).toBeTruthy();
    expect(screen.queryByText('Sheet Thing')).toBeNull();
    unmount();
    window.history.replaceState(null, '', '/whats-new?tab=timeline&module=hr/time,myhr/timesheet');
    render(<Changelog />);
    await screen.findAllByText('Review Thing');
    expect(screen.getAllByText('Sheet Thing').length).toBeGreaterThan(0);
    expect(screen.queryByText('Clock Thing')).toBeNull();
  });

  it('each row names its developer on the left, with their photo; no match shows initials', async () => {
    api.getTaskChangelog.mockResolvedValue([
      rel('a', 'Clock Thing', 'Workday', { developers: [
        { login: 'pranshuup', name: 'Pranshu Pandey', email: 'pranshu.pandey@greensglobal.com' },
        { login: 'someone', name: 'Some One' }] }),
      rel('b', 'Sheet Thing', 'Time Sheet', { releasedAt: at(9), developers: [{ login: 'outsider', name: 'Out Sider' }] }),
      rel('c', 'Review Thing', 'Time Sheets to Review', { releasedAt: at(8), authorId: 'amy@greensglobal.com' }),
    ]);
    render(<Changelog />);
    await screen.findAllByText('Clock Thing');
    const authors = [...document.querySelectorAll('[data-row-author]')];
    expect(authors.map((a) => a.getAttribute('title'))).toEqual(['Pranshu Pandey and 1 other', 'Out Sider', 'Amy']);
    expect(within(authors[0]).getByAltText('Pranshu Pandey').getAttribute('src')).toBe('https://example.test/pranshu.jpg');
    expect(authors[0].textContent).toContain('+1');
    expect(within(authors[1]).getByText('OS')).toBeTruthy();                    // initials, no photo
    // The time stays on one line in the app's font, never a typewriter face.
    const time = document.querySelector('[data-row-time]');
    expect(time.textContent).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    expect(time.style.whiteSpace).toBe('nowrap');
    expect(time.style.fontFamily).not.toMatch(/mono/i);
  });

  it('Today and Yesterday filter to the local day, combine with the module filter, and clear on a second click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 4, 15, 0));                            // 11/04/2026, afternoon
    try {
      api.getTaskChangelog.mockResolvedValue([
        rel('t', 'Today Thing', 'Workday', { releasedAt: new Date(2026, 10, 4, 0, 30).toISOString() }),
        rel('y', 'Yesterday Thing', 'Workday', { releasedAt: new Date(2026, 10, 3, 23, 30).toISOString() }),
        rel('o', 'Old Thing', 'Workday', { releasedAt: new Date(2026, 10, 1, 9, 0).toISOString() }),
        rel('d', 'Dash Today', 'Dashboard > Approvals', { releasedAt: new Date(2026, 10, 4, 9, 0).toISOString() }),
      ]);
      render(<Changelog />);
      await screen.findAllByText('Old Thing');
      const today = screen.getByRole('button', { name: 'Today' });
      fireEvent.click(today);
      expect(today.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getAllByText('Today Thing').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Dash Today').length).toBeGreaterThan(0);
      expect(screen.queryByText('Yesterday Thing')).toBeNull();
      expect(screen.queryByText('Old Thing')).toBeNull();
      fireEvent.click(within(screen.getByRole('group', { name: 'Module' })).getAllByRole('button')[0]);
      fireEvent.click(screen.getByRole('option', { name: /^Workday/ }));
      expect(screen.queryByText('Dash Today')).toBeNull();                      // both filters at once
      expect(screen.getAllByText('Today Thing').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
      expect(screen.getAllByText('Yesterday Thing').length).toBeGreaterThan(0);
      expect(screen.queryByText('Today Thing')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));       // again = off
      expect(screen.getAllByText('Old Thing').length).toBeGreaterThan(0);
      expect(window.location.search).not.toContain('from=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('every row and the detail name the pull request; the detail links to it', async () => {
    render(<Changelog />);
    await screen.findAllByText('Clock Thing');
    const link = await screen.findByRole('link', { name: '#990' });               // the detail
    expect(screen.getAllByText('#990')).toHaveLength(2);                        // and the row
    const row = document.querySelector('[data-row-author]').closest('button');
    expect(row.textContent).toContain('#990');
    expect(row.textContent).not.toContain('In Production');                     // shipped = no mark on the row
    expect(link.getAttribute('href')).toBe('https://github.com/Greens-Global/Greens-Nexus/pull/990');
    expect(screen.getAllByText('Workday - Time Sheet').length).toBeGreaterThan(0);  // the row's place
  });

  it('the bar between the list and the detail resizes them by keyboard, remembers it, and resets', async () => {
    render(<Changelog />);
    await screen.findAllByText('Clock Thing');
    const bar = screen.getByRole('separator', { name: 'Resize the timeline and the details' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect(window.localStorage.getItem('nexus.whatsNew.timelineSplit')).toBe('62');
    fireEvent.keyDown(bar, { key: 'End' });
    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    const grid = document.querySelector('[data-timeline-split]');
    expect(grid.style.gridTemplateColumns).toContain('75fr');
    fireEvent.doubleClick(bar);
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });
});
