import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// What's New changes (Pranshu, Oct 16 2026): merged work still publishes on
// its own (no ask-to-publish bar); Manage is a button; Version History is part of
// the Timeline; an update can be edited and re-published; everyone reacts, and
// admins see who was reached.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
    publishTaskChangelog: vi.fn(), publishPendingTaskChangelog: vi.fn(), reactTaskChangelog: vi.fn(),
    recordTaskChangelogViews: vi.fn(), getTaskChangelogAnalytics: vi.fn(), getTaskChangelogEntryAnalytics: vi.fn(),
    updateTaskChangelog: vi.fn(), addTaskChangelogComment: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  MODULES: [{ id: 'tickets', label: 'Tickets' }, { id: 'tasks', label: 'Tasks' }],
  useRole: () => ({ myEmail: 'admin@greensglobal.com', can: () => true }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';

const at = (h, day = 15) => new Date(2026, 9, day, h, 0).toISOString();
const released = (id, title, extra = {}) => ({
  id, title, description: 'Plain words.', type: 'Bug Fix', module: 'Tasks', status: 'Released',
  releasedAt: at(10), authorId: 'admin@greensglobal.com', reactions: {}, myReactions: [], commentCount: 0, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Filters live in the address bar; each test starts from a clean one.
  window.history.replaceState(null, '', '/whats-new');
  api.getTaskChangelog.mockResolvedValue([
    released('e1', 'Faster Lists', { version: 'v2.9.0', reactions: { like: 2 } }),
    released('e2', 'Older Fix', { releasedAt: at(10, 13), version: '10/13/2026', type: 'Improvement' }),
    { id: 'd1', title: 'Merged Draft', description: 'x', type: 'New Feature', module: 'HR', origin: 'pr', status: 'Pending Review' },
    { id: 'd2', title: 'Second Draft', description: 'x', type: 'Bug Fix', module: 'HR', origin: 'pr', status: 'Pending Review' },
  ]);
  api.getTaskChangelogAutoStatus.mockResolvedValue({ enabled: true });
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([]);
  api.recordTaskChangelogViews.mockResolvedValue({ ok: true });
  api.getTaskChangelogAnalytics.mockResolvedValue({
    totals: { peopleReached: 7, views: 12, reactions: 3, reactors: 2, comments: 1 },
    entries: { e1: { viewers: 5, views: 9, reactions: { like: 2 }, reactionTotal: 2, comments: 1 } },
  });
});

describe("What's New publishing", () => {
  it('never asks on the feed to publish; submissions waiting in review publish from Manage', async () => {
    api.publishPendingTaskChangelog.mockResolvedValue({
      published: 2, entries: [{ id: 'd1', title: 'Merged Draft', status: 'Released', releasedAt: at(12) },
        { id: 'd2', title: 'Second Draft', status: 'Released', releasedAt: at(12) }],
    });
    render(<Changelog />);
    await screen.findByText('Faster Lists');
    expect(screen.queryByText(/waiting to be published/)).toBeNull();
    expect(screen.queryByText('Merged Draft')).toBeNull();                 // still out of the feed
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Publish All/ }));
    await waitFor(() => expect(api.publishPendingTaskChangelog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Back to What's New/ }));
    expect(await screen.findByText('Merged Draft')).toBeTruthy();
  });

  it('Manage is a button with the waiting count; Back returns to the tabs', async () => {
    render(<Changelog />);
    const manage = await screen.findByRole('button', { name: 'Manage' });
    // The waiting count arrives after the button (its own request) - wait for it.
    await waitFor(() => expect(manage.textContent).toBe('Manage2'));
    fireEvent.click(manage);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(await screen.findByText('People Reached')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to What's New/ }));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Latest', 'Timeline']);
  });

  it('a published update can be re-published from Manage', async () => {
    api.publishTaskChangelog.mockResolvedValue(released('e1', 'Faster Lists', { releasedAt: at(13), republishedAt: at(13) }));
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Re-publish Faster Lists' }));
    await waitFor(() => expect(api.publishTaskChangelog).toHaveBeenCalledWith('e1'));
    expect(await screen.findByText('Update re-published.')).toBeTruthy();
  });

  it('Edit on a card offers Save & Re-publish, which saves and then publishes', async () => {
    api.updateTaskChangelog.mockResolvedValue(released('e1', 'Faster Lists Now'));
    api.publishTaskChangelog.mockResolvedValue(released('e1', 'Faster Lists Now', { releasedAt: at(13) }));
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Faster Lists' }));
    fireEvent.change(screen.getByDisplayValue('Faster Lists'), { target: { value: 'Faster Lists Now' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. v2.8.1'), { target: { value: 'v2.9.1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & Re-publish/ }));
    await waitFor(() => expect(api.publishTaskChangelog).toHaveBeenCalledWith('e1'));
    const saved = api.updateTaskChangelog.mock.calls[0][1].payload;
    expect(saved.title).toBe('Faster Lists Now');
    expect(saved).not.toHaveProperty('reactions');                       // read out, never saved
    expect(saved).not.toHaveProperty('commentCount');
  });
});

describe('Reactions and views', () => {
  it('a reaction shows at once and takes the server count', async () => {
    api.reactTaskChangelog.mockResolvedValue({ reactions: { like: 3 }, myReactions: ['like'] });
    render(<Changelog />);
    const like = await screen.findByRole('button', { name: 'Like (2)' });
    expect(like.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(like);
    const on = await screen.findByRole('button', { name: 'Like (3)' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(api.reactTaskChangelog).toHaveBeenCalledWith('e1', 'like');
  });

  it('one reaction per person: another kind replaces yours', async () => {
    api.getTaskChangelog.mockResolvedValue([released('r1', 'One Each', { reactions: { like: 2 }, myReactions: ['like'] })]);
    api.reactTaskChangelog.mockReturnValue(new Promise(() => {}));     // the screen's own count is what is checked
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Celebrate' }));
    expect(screen.getByRole('button', { name: 'Like (1)' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Celebrate (1)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    // The picked pill pops and its emoji floats up from it.
    const picked = screen.getByRole('button', { name: 'Celebrate (1)' });
    expect(picked.classList.contains('is-popping')).toBe(true);
    expect(picked.querySelector('.nx-react-float')).not.toBeNull();
  });

  it("counts the latest day's cards as seen, once per page load", async () => {
    // An id no other test has shown: views are remembered for the page load.
    api.getTaskChangelog.mockResolvedValue([released('v1', 'Seen Once')]);
    const { unmount } = render(<Changelog />);
    await screen.findByText('Seen Once');
    await waitFor(() => expect(api.recordTaskChangelogViews).toHaveBeenCalledWith(['v1']));
    unmount();
    render(<Changelog />);
    await screen.findByText('Seen Once');
    expect(api.recordTaskChangelogViews).toHaveBeenCalledTimes(1);
  });
});

describe('Timeline with Version History folded in', () => {
  it('has no Version History tab; days name their typed versions and a filter picks one', async () => {
    render(<Changelog />);
    await screen.findByText('Faster Lists');
    expect(screen.queryByRole('tab', { name: /Version/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByRole('option', { name: 'v2.9.0' })).toBeTruthy();
    // The day header names a typed version; a merge's date-version would only
    // repeat the date, so it is left out.
    const day = screen.getByText('1 Improvement').parentElement;
    expect(day.textContent.match(/10\/13\/2026/g)).toHaveLength(1);
    expect(screen.getByText('1 Bug Fix').parentElement.textContent).toContain('v2.9.0');
    expect(screen.getByText('1 Improvement')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '10/13/2026' } });
    expect(screen.getByText('1 entry')).toBeTruthy();
  });
});

describe('Comments on the card', () => {
  it('every card has a comment box; posting opens the thread with yours in it', async () => {
    api.getTaskChangelog.mockResolvedValue([released('c0', 'Quiet One')]);
    api.getTaskChangelogComments.mockResolvedValue([{ id: 'y1', authorId: 'admin@greensglobal.com', body: 'First!', createdAt: at(11) }]);
    api.addTaskChangelogComment.mockResolvedValue({ id: 'y1' });
    render(<Changelog />);
    await screen.findByText('Quiet One');
    expect(screen.getByRole('button', { name: '0 comments' })).toBeTruthy();   // the count shows even at 0
    expect(api.getTaskChangelogComments).not.toHaveBeenCalled();          // no thread fetched per card
    const box = screen.getByLabelText('Add a comment');
    expect(box.tagName).toBe('TEXTAREA');
    fireEvent.change(box, { target: { value: 'First!' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.addTaskChangelogComment).toHaveBeenCalledWith('c0', { body: 'First!' }));
    expect(await screen.findByText('First!')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Hide comments/ })).toBeTruthy();
  });

  it('opens the thread on the card and posts a comment without leaving it', async () => {
    api.getTaskChangelog.mockResolvedValue([released('c1', 'Talk About It', { commentCount: 1 })]);
    api.getTaskChangelogComments
      .mockResolvedValueOnce([{ id: 'x1', authorId: 'pranshu.pandey@greensglobal.com', body: 'Looks good', createdAt: at(9) }])
      .mockResolvedValueOnce([{ id: 'x1', authorId: 'pranshu.pandey@greensglobal.com', body: 'Looks good', createdAt: at(9) },
        { id: 'x2', authorId: 'admin@greensglobal.com', body: 'Thanks!', createdAt: at(11) }]);
    api.addTaskChangelogComment.mockResolvedValue({ id: 'x2' });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: /1 comment/ }));
    expect(await screen.findByText('Looks good')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: 'Thanks!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() => expect(api.addTaskChangelogComment).toHaveBeenCalledWith('c1', { body: 'Thanks!' }));
    expect(await screen.findByText('Thanks!')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Hide comments/ })).toBeTruthy();
    expect(screen.getByLabelText('Add a comment').value).toBe('');
  });

  it("says What's New once in the page, not again in the tab", async () => {
    render(<Changelog />);
    await screen.findByText('Faster Lists');
    expect(screen.getAllByText("What's New")).toHaveLength(1);
  });
});
