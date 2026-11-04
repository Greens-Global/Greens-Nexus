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
    rel('a', 'Clock Thing', 'Workday', { prNumber: 990, prRef: '#990', prUrl: 'https://github.com/Greens-Global/Greens-Nexus/pull/990' }),
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
  it('lists the sections in navigation order with their pages and counts, and a section takes in its pages', async () => {
    render(<Changelog />);
    await screen.findAllByText('Sheet Thing');
    const select = screen.getByLabelText('Module');
    const options = within(select).getAllByRole('option').map((o) => o.textContent.replace(' ', '  '));
    expect(options).toEqual([
      'All Modules', 'Dashboard (1)', '  Dashboard - Approvals (1)', 'Workday (2)', '  Workday - Time Sheet (1)',
      'People (1)', '  People - Time (1)',
    ]);
    fireEvent.change(select, { target: { value: 'myhr' } });
    expect(screen.getAllByText('Sheet Thing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Clock Thing').length).toBeGreaterThan(0);
    expect(screen.queryByText('Review Thing')).toBeNull();
    expect(window.location.search).toContain('module=myhr');
    fireEvent.change(select, { target: { value: 'myhr/timesheet' } });
    expect(screen.queryByText('Clock Thing')).toBeNull();
  });

  it('a shared link with an old module name still filters', async () => {
    window.history.replaceState(null, '', '/whats-new?tab=timeline&module=Time%20Sheets%20to%20Review');
    render(<Changelog />);
    await screen.findAllByText('Review Thing');
    expect(screen.getByLabelText('Module').value).toBe('hr/time');
    expect(screen.queryByText('Sheet Thing')).toBeNull();
  });

  it('every row and the detail name the pull request; the detail links to it', async () => {
    render(<Changelog />);
    await screen.findAllByText('Clock Thing');
    const link = await screen.findByRole('link', { name: '#990' });               // the detail
    expect(screen.getAllByText('#990').length).toBeGreaterThanOrEqual(2);       // and the row
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
