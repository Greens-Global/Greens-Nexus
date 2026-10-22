import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// What's New, Oct 16 2026: pinned updates, For You, new since your last
// visit, shared links, Timeline date range / compare / breaking, threaded
// comments with mentions, helpful votes, follow + feed, bulk actions,
// insights, the richer form (schedule, audience, related), screen hints.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
    addTaskChangelogComment: vi.fn(), recordTaskChangelogViews: vi.fn(), getTaskChangelogMe: vi.fn(),
    getTaskChangelogAnalytics: vi.fn(), getTaskChangelogInsights: vi.fn(), getTaskChangelogFeedbackList: vi.fn(),
    bulkTaskChangelog: vi.fn(), getTaskChangelogFeedback: vi.fn(), sendTaskChangelogFeedback: vi.fn(),
    saveTaskChangelogSubscription: vi.fn(), getTaskChangelogFeedLink: vi.fn(), rotateTaskChangelogFeedLink: vi.fn(),
    createTaskChangelog: vi.fn(), getTaskChangelogAudienceOptions: vi.fn(), getTaskChangelogHints: vi.fn(),
    getTaskChangelogHistory: vi.fn(), getTaskChangelogEntryAnalytics: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  MODULES: [{ id: 'tickets', label: 'Tickets' }, { id: 'tasks', label: 'Tasks' }],
  useRole: () => ({ myEmail: 'admin@greensglobal.com', can: (r) => r !== 'administrator', myGrantedModules: new Map([['tickets', 'editor']]) }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';
import { embedOf, nextVersions, WhatsNewHint } from './changelogExtras';

const at = (h, day = 15) => new Date(2026, 9, day, h, 0).toISOString();
const rel = (id, title, extra = {}) => ({
  id, title, description: 'Plain words.', type: 'Bug Fix', module: 'Tickets', status: 'Released',
  releasedAt: at(10), authorId: 'admin@greensglobal.com', reactions: {}, myReactions: [], commentCount: 0, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/whats-new');
  api.getTaskChangelog.mockResolvedValue([
    rel('t1', 'Ticket Fix'),
    rel('k1', 'Tasks Fix', { module: 'Tasks' }),
    rel('p1', 'Pinned Notice', { pinned: true, pinnedAt: at(8, 1), releasedAt: at(8, 1), type: 'Maintenance' }),
    rel('b1', 'Breaking Thing', { breaking: true, actionRequired: 'Re-sign your timecards', releasedAt: at(9, 12), version: 'v2.0.0' }),
    rel('o1', 'Old Thing', { releasedAt: at(9, 2), version: 'v1.0.0' }),
  ]);
  api.getTaskChangelogMe.mockResolvedValue({ sinceAt: at(9, 11), subscription: { modules: [], categories: [], digest: false } });
  api.getTaskChangelogAutoStatus.mockResolvedValue({ enabled: true });
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([{ email: 'amy@greensglobal.com', name: 'Amy Bolanos' }]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.recordTaskChangelogViews.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([]);
  api.getTaskChangelogAnalytics.mockResolvedValue({ totals: {}, entries: {} });
  api.getTaskChangelogInsights.mockResolvedValue({
    entries: { t1: { readRate: 40 } }, trends: [{ week: '2026-10-12', published: 2, views: 5, reactions: 1, comments: 0 }],
    topReacted: [{ id: 't1', title: 'Ticket Fix', reactions: 4 }], averageReadRate: 40, helpful: { yes: 3, no: 1, rate: 75 },
  });
  api.getTaskChangelogFeedbackList.mockResolvedValue([{ id: 'f1', entryId: 't1', entryTitle: 'Ticket Fix', email: 'amy@greensglobal.com', kind: 'request', note: 'Export please', at: at(9) }]);
  api.getTaskChangelogFeedback.mockResolvedValue({ yes: 0, no: 0, mine: null });
  api.getTaskChangelogAudienceOptions.mockResolvedValue({ companies: [{ id: 'c1', name: 'Greens' }] });
  api.getTaskChangelogFeedLink.mockResolvedValue({ url: 'http://localhost:8000/task-changelog-feed/abc.xml' });
});

describe('Latest tab', () => {
  it('puts pinned updates on top, marks new ones and flags breaking changes', async () => {
    render(<Changelog />);
    const pinned = await screen.findByText('Pinned Notice');
    expect(pinned.closest('[data-whats-new-pinned]')).not.toBeNull();
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);                 // released after sinceAt
    fireEvent.click(screen.getByRole('button', { name: /New Updates? Since Your Last Visit/ }));
    expect(await screen.findByText('Breaking Thing')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Re-sign your timecards');
    expect(screen.queryByText('Old Thing')).toBeNull();
  });

  it('For You keeps the modules you use', async () => {
    render(<Changelog />);
    await screen.findByText('Tasks Fix');
    fireEvent.click(screen.getByRole('button', { name: /For You/ }));
    expect(screen.queryByText('Tasks Fix')).toBeNull();
    expect(screen.getByText('Ticket Fix')).toBeTruthy();
    expect(window.location.search).toContain('for=me');                          // shareable
  });

  it('a link with ?entry= opens that update', async () => {
    window.history.replaceState(null, '', '/whats-new?entry=o1');
    render(<Changelog />);
    expect(await screen.findByRole('heading', { name: 'Old Thing' })).toBeTruthy();
  });
});

describe('Timeline', () => {
  const open = async () => {
    render(<Changelog />);
    await screen.findByText('Ticket Fix');
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
  };
  it('filters by a date range shown as MM/DD/YYYY, from a shared link, and clears', async () => {
    window.history.replaceState(null, '', '/whats-new?tab=timeline&from=2026-10-10');
    render(<Changelog />);
    await screen.findByText('Ticket Fix');
    expect(screen.getByText(/^\d+ entr/).textContent).toBe('3 entries');     // t1, k1, b1
    const from = screen.getByTitle('From date');
    expect(from.textContent).toBe('10/10/2026');                            // never dd-mm-yyyy
    expect(screen.getByTitle('To date').textContent).toBe('MM/DD/YYYY');
    fireEvent.click(from);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/^\d+ entr/).textContent).toBe('5 entries');
    expect(window.location.search).not.toContain('from=');
  });
  it('compares two versions and shows only breaking changes on request', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Compare Versions/ }));
    fireEvent.change(screen.getByLabelText('Compare from version'), { target: { value: 'v1.0.0' } });
    fireEvent.change(screen.getByLabelText('Compare to version'), { target: { value: 'v2.0.0' } });
    expect(screen.getByText('1 entry')).toBeTruthy();                             // after v1.0.0, up to v2.0.0: b1
    fireEvent.click(screen.getByRole('button', { name: /Compare Versions/ }));
    fireEvent.click(screen.getByLabelText(/Breaking \/ Action Required/));
    expect(screen.getByText('1 entry')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Clear Filters/ }));
    expect(screen.getByText('5 entries')).toBeTruthy();
  });
});

describe('Comments', () => {
  it('replies sit under their comment, and @ mentions a person', async () => {
    api.getTaskChangelog.mockResolvedValue([rel('c1', 'Talk', { commentCount: 2 })]);
    api.getTaskChangelogComments.mockResolvedValue([
      { id: 'x1', authorId: 'amy@greensglobal.com', body: 'Question', createdAt: at(9) },
      { id: 'x2', authorId: 'admin@greensglobal.com', body: 'Answer', parentId: 'x1', createdAt: at(10) },
    ]);
    api.addTaskChangelogComment.mockResolvedValue({ id: 'x3' });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: '2 comments' }));
    const answer = await screen.findByText('Answer');
    expect(answer.closest('[style*="border-left"]')).not.toBeNull();             // indented under its comment
    const box = screen.getAllByLabelText('Add a comment').at(-1);
    fireEvent.change(box, { target: { value: 'Thanks @Amy', selectionStart: 11 } });
    box.selectionStart = 11;
    fireEvent.change(box, { target: { value: 'Thanks @Amy' } });
    const option = await screen.findByRole('option', { name: /Amy Bolanos/ });
    fireEvent.mouseDown(option);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.addTaskChangelogComment).toHaveBeenCalled());
    const [, body] = api.addTaskChangelogComment.mock.calls[0];
    expect(body.body).toContain('@Amy Bolanos');
    expect(body.mentions).toEqual(['amy@greensglobal.com']);
  });
});

describe('Manage', () => {
  it('shows insights and requests, and runs a bulk action', async () => {
    api.bulkTaskChangelog.mockResolvedValue({ done: 2, entries: [rel('t1', 'Ticket Fix', { hidden: true }), rel('k1', 'Tasks Fix', { hidden: true })] });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Last 12 Weeks')).toBeTruthy();
    expect(screen.getByText(/Average read rate 40%/)).toBeTruthy();
    expect(screen.getByText('Export please')).toBeTruthy();
    expect(screen.getByText('40% read')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Select Ticket Fix'));
    fireEvent.click(screen.getByLabelText('Select Tasks Fix'));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(api.bulkTaskChangelog).toHaveBeenCalledWith({ ids: ['t1', 'k1'], action: 'hide' }));
    expect(await screen.findAllByText('Hidden')).toHaveLength(2);
  });

  it('schedules an update with an audience from the form', async () => {
    api.createTaskChangelog.mockImplementation(async ({ payload }) => ({ id: 'n1', ...payload }));
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add New Update' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Fixed leave balance calculation'), { target: { value: 'Coming Soon' } });
    fireEvent.change(screen.getByPlaceholderText('What changed, and why it matters to the people using it.'), { target: { value: '**Big** news' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. HR, Dashboard, Tasks'), { target: { value: 'Tickets' } });
    fireEvent.click(screen.getByRole('button', { name: /Minor v2\.1\.0/ }));      // after v2.0.0
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Scheduled' } });
    // A date box and a 12-hour time box (never a native datetime-local):
    // tomorrow from the calendar, then 9:00 AM. The calendar always shows
    // the first days of next month, and past days cannot be picked, so the
    // first enabled cell with tomorrow's number is tomorrow.
    const when = new Date(Date.now() + 86_400_000);
    fireEvent.click(screen.getByTitle('Scheduled for'));
    const cal = document.querySelector('[data-nx-calendar]');
    const day = [...cal.querySelectorAll('button')].find((b) => b.textContent === String(when.getDate()) && !b.disabled);
    fireEvent.click(day);
    fireEvent.change(screen.getByLabelText('Scheduled time'), { target: { value: '09:00' } });
    expect(screen.getByLabelText('Scheduled time').selectedOptions[0].textContent).toBe('9:00 AM');
    fireEvent.click(screen.getByRole('button', { name: 'Tickets', pressed: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish Update' }));
    await waitFor(() => expect(api.createTaskChangelog).toHaveBeenCalled());
    const { payload } = api.createTaskChangelog.mock.calls[0][0];
    expect(payload).toMatchObject({ status: 'Scheduled', version: 'v2.1.0', audience: { modules: ['tickets'] } });
    expect(new Date(payload.scheduledFor).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('Follow', () => {
  it('saves modules, categories and the digest, and shows the private feed link', async () => {
    api.saveTaskChangelogSubscription.mockResolvedValue({ modules: ['tickets'], categories: ['bug fix'], digest: true });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(await screen.findByDisplayValue(/task-changelog-feed\/abc\.xml/)).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tickets' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bug Fix' }));
    fireEvent.click(within(dialog).getByLabelText(/weekly digest/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveTaskChangelogSubscription).toHaveBeenCalledWith({ modules: ['tickets'], categories: ['bug fix'], digest: true }));
  });
});

describe('Helpers', () => {
  it('embeds the video hosts the site allows, and only those', () => {
    expect(embedOf('https://youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
    expect(embedOf('https://www.loom.com/share/abc123').src).toBe('https://www.loom.com/embed/abc123');
    expect(embedOf('https://vimeo.com/12345').src).toBe('https://player.vimeo.com/video/12345');
    expect(embedOf('https://x.supabase.co/storage/v1/object/public/a/demo.mp4').kind).toBe('video');
    expect(embedOf('https://evil.example/demo.mp4').kind).toBe('link');
    expect(embedOf('javascript:alert(1)')).toBeNull();
  });
  it('suggests the next versions after the highest one', () => {
    expect(nextVersions([{ version: 'v1.9.3' }, { version: 'v1.10.0' }, { version: '10/16/2026' }]))
      .toEqual({ patch: 'v1.10.1', minor: 'v1.11.0', major: 'v2.0.0' });
  });
  it('the screen hint shows once and can be dismissed', async () => {
    window.localStorage.clear();
    api.getTaskChangelogHints.mockResolvedValue([{ id: 'h1', title: 'New Ticket Filters', type: 'Improvement', releasedAt: at(9) }]);
    const { unmount } = render(<WhatsNewHint view="tickets" />);
    expect(await screen.findByText('New Ticket Filters', {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('New Ticket Filters')).toBeNull();
    unmount();
    render(<WhatsNewHint view="tickets" />);
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.queryByText('New Ticket Filters')).toBeNull();
  });
});

describe('Latest layout', () => {
  it('pinned updates sit in the left column, so the summary starts beside the first card', async () => {
    render(<Changelog />);
    await screen.findByText('Pinned Notice');
    const row = document.querySelector('[data-whats-new-row]');
    const [left, right] = row.children;
    expect(left.contains(document.querySelector('[data-whats-new-pinned]'))).toBe(true);
    expect(right.textContent).toContain('Activity Summary');
    // the Pinned label opens the left column; the count line the right one
    expect(left.querySelector('[data-col-label]').textContent).toBe('Pinned');
    expect(left.querySelector('[data-col-label]').style.height).toBe(right.firstElementChild.style.height);
  });
});

describe('Pin from the card', () => {
  it('an admin pins and unpins in one click', async () => {
    api.bulkTaskChangelog.mockResolvedValueOnce({ done: 1, entries: [rel('t1', 'Ticket Fix', { pinned: true, pinnedAt: at(11) })] });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Ticket Fix' }));
    await waitFor(() => expect(api.bulkTaskChangelog).toHaveBeenCalledWith({ ids: ['t1'], action: 'pin' }));
    const unpin = await screen.findByRole('button', { name: 'Unpin Ticket Fix' });
    expect(unpin.closest('[data-whats-new-pinned]')).not.toBeNull();       // moved up to Pinned
    expect(await screen.findByText('Pinned to the top.')).toBeTruthy();
  });
});

describe('Manage > Pending Review', () => {
  it('is hidden while nothing waits, and shows when a submission does', async () => {
    const { unmount } = render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await screen.findByText('All Updates');
    expect(screen.queryByRole('heading', { name: 'Pending Review' })).toBeNull();
    unmount();
    api.getTaskChangelog.mockResolvedValue([rel('t1', 'Ticket Fix'),
      { id: 's1', title: 'From a Teammate', description: 'x', type: 'Improvement', module: 'HR', status: 'Pending Review', authorId: 'amy@greensglobal.com' }]);
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('heading', { name: 'Pending Review' })).toBeTruthy();
    expect(screen.getByText('From a Teammate')).toBeTruthy();
  });
});

describe('Print / PDF', () => {
  it('prints a report of its own - every update and its numbers - not the screen', async () => {
    const { buildPrintReport } = await import('./changelogExtras');
    const html = buildPrintReport(
      [rel('t1', 'Ticket <Fix>', { actionRequired: 'Re-sign', pinned: true }), rel('d1', 'Draft One', { status: 'Draft' })],
      { totals: { peopleReached: 7, views: 12, reactions: 3, comments: 1 }, entries: { t1: { viewers: 5, reactionTotal: 2, comments: 1 } } },
      { averageReadRate: 40, helpful: { rate: 75 }, entries: { t1: { readRate: 40 } } },
      (e) => e.status,
    );
    expect(html).toContain('Ticket &lt;Fix&gt;');                  // escaped, never raw HTML
    expect(html).toContain('Action required: Re-sign');
    expect(html).toContain('Pinned');
    expect(html).toContain('Draft One');
    expect(html).toMatch(/People Reached<\/div><div class="v">7/);
    expect(html).toContain('40%');
    expect(html).not.toContain('<script');
  });
});
