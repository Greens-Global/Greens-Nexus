import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Tasks Home on a phone (Neil, Oct 14 2026): no summary tiles, the range
// picker in the Tasks card, and the Updates card - other people's recent
// changes to the tasks I am on. Since Oct 15 Tasks, Updates and Bookmarks are
// the core of Home (always there, side by side at a desk), and an update is
// a grouped, relevance-filtered summary (`parts`, `forYou`, `preview`).

let store;
let mobile = true;
let savedHome;
const activity = vi.fn(() => Promise.resolve([]));
const seen = vi.fn(() => Promise.resolve({ seenAt: '' }));
const respond = vi.fn(() => Promise.resolve({}));
const reply = vi.fn(() => Promise.resolve({}));
const react = vi.fn(() => Promise.resolve({}));
const editComment = vi.fn(() => Promise.resolve({}));

vi.mock('./TasksContext', () => ({ useTasks: () => store }));
vi.mock('../api', () => ({ api: {
  getMyTaskActivity: (...a) => activity(...a), markUpdatesSeen: (...a) => seen(...a),
  respondTaskDue: (...a) => respond(...a), addTaskComment: (...a) => reply(...a),
  reactTaskComment: (...a) => react(...a), editTaskComment: (...a) => editComment(...a),
} }));
vi.mock('./TaskDetailDrawer', () => ({ default: ({ taskId, focusComment }) => <div data-testid="drawer">{taskId}{focusComment ? `@${focusComment.id}` : ''}</div> }));
vi.mock('./ManageView', () => ({ DeletedTasksTab: () => null }));
vi.mock('../components/AnchoredMenu', () => ({ default: ({ open, children }) => (open ? <div>{children}</div> : null) }));
vi.mock('./components', async (orig) => {
  const real = await orig();
  return { ...real, useIsMobile: () => mobile, Avatar: ({ name }) => <span data-avatar>{name}</span> };
});
vi.mock('./tableCols', async (orig) => {
  const real = await orig();
  return {
    ...real,
    whenTablePrefsLoaded: () => Promise.resolve({ prefs: {}, fromServer: true }),
    useTableValue: (table, name, fallback) => {
      const [v, setV] = useState(table === 'home' ? savedHome : fallback);
      return [v, (next) => setV((cur) => (typeof next === 'function' ? next(cur) : next))];
    },
  };
});

const { default: HomeView } = await import('./HomeView');

const ME = 'neil@greensglobal.com';
const SAGAR = 'sagar@greensglobal.com';
const minutesAgo = (m) => new Date(Date.now() - m * 60e3).toISOString();
const yesterdayNoon = () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.toISOString(); };

beforeEach(() => {
  mobile = true;
  savedHome = undefined;
  activity.mockReset();
  seen.mockReset();
  for (const f of [respond, reply, react, editComment]) f.mockClear();
  seen.mockImplementation(() => Promise.resolve({ seenAt: '' }));
  activity.mockImplementation(() => Promise.resolve([
    { id: 'a1', type: 'status_changed', actorId: SAGAR, at: minutesAgo(5), detail: 'changed status to in_progress', taskId: 't1', relation: 'assignee', entityTitle: 'Fix roof' },
    { id: 'a2', type: 'commented', actorId: SAGAR, at: minutesAgo(180), detail: 'added a comment', taskId: 't2', relation: 'collaborator', entityTitle: 'Paint fence' },
  ]));
  store = {
    tasks: [
      { id: 't1', title: 'Fix roof', type: 'task', assigneeIds: [ME], dueOn: '2099-01-01', completed: false, projectId: 'p1' },
      { id: 't2', title: 'Paint fence', type: 'task', assigneeIds: [SAGAR], followerIds: [ME], completed: false },
    ],
    projects: [], teams: [], notifications: [], bookmarks: new Set(), loading: false,
    projectName: (id) => ({ p1: 'Operations' }[id] || ''),
    myEmail: ME, nameOf: (e) => ({ [SAGAR]: 'Sagar P', [ME]: 'Neil K' }[e] || ''),
    statusMeta: { in_progress: { label: 'In Progress' } },
    createTask: vi.fn(), toggleComplete: vi.fn(),
  };
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('Tasks Home on a phone', () => {
  it('drops the summary tiles and keeps the range picker in the Tasks card', async () => {
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.queryByTitle('Show overdue tasks')).toBeNull();     // the Overdue tile
    expect(screen.queryByText('Priority')).toBeNull();
    const picker = screen.getByText('This Week');
    expect(picker.closest('[data-home-tasks]')).toBeTruthy();          // in the Tasks card
    fireEvent.click(picker);
    // "Today" is also a day label elsewhere on the screen - take the menu's button.
    const todayButtons = () => screen.getAllByText('Today').filter((el) => el.tagName === 'BUTTON');
    expect(todayButtons()).toHaveLength(1);
    fireEvent.click(todayButtons()[0]);
    expect(screen.queryByText('This Month')).toBeNull();                 // the menu closed...
    expect(todayButtons()).toHaveLength(1);                             // ...and the pick is on the button
    expect(screen.queryByText('This Week')).toBeNull();
  });

  it('keeps the tiles at a desk', async () => {
    mobile = false;
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.getByTitle('Show overdue tasks')).toBeTruthy();
  });
});

describe('the Updates card', () => {
  it('lists what others did on my tasks, newest first, and opens the task', async () => {
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(activity).toHaveBeenCalledTimes(1);
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Sagar P');
    expect(rows[0].textContent).toContain('changed the status to In Progress');   // the key becomes its label
    expect(rows[0].textContent).toContain('Fix roof');
    expect(rows[0].textContent).toContain('5m ago');
    expect(rows[1].textContent).toContain('added a comment');
    expect(rows[1].textContent).toContain('Following');                          // a task I follow, not mine
    expect(rows[1].textContent).toContain('3h ago');
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('drawer').textContent).toBe('t1');
  });

  it('shows what a comment said, and a mention as "mentioned you" (Oct 18)', async () => {
    activity.mockImplementation(() => Promise.resolve([
      { id: 'c1', type: 'commented', actorId: SAGAR, at: minutesAgo(2), detail: 'added a comment', taskId: 't2', relation: 'collaborator', preview: 'Permit is approved', entityTitle: 'Paint fence' },
      { id: 'c2', type: 'commented', actorId: SAGAR, at: minutesAgo(4), detail: 'added a comment', taskId: 'tx', relation: 'mentioned', preview: 'Can you check @Neil?', entityTitle: 'Other task' },
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows[0].textContent).toContain('Sagar P added a comment');
    expect(rows[0].textContent).toContain('Permit is approved');
    expect(rows[1].textContent).toContain('Sagar P mentioned you');
    expect(rows[1].textContent).toContain('Other task');
    expect(rows[1].hasAttribute('data-for-you')).toBe(false);   // forYou comes from the server
    // A task this screen has not loaded is not offered as a button.
    expect(rows[1].getAttribute('role')).toBe(null);
  });

  it('reads once on open, and again only when a task actually changed', async () => {
    const { rerender } = render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(activity).toHaveBeenCalledTimes(1);
    store = { ...store, tasks: store.tasks.map((t) => ({ ...t })) };        // the 45s poll: same data, new array
    rerender(<HomeView onNavigate={() => {}} />);
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(activity).toHaveBeenCalledTimes(1);
    store = { ...store, tasks: store.tasks.map((t) => (t.id === 't1' ? { ...t, modifiedAt: '2099-01-01T00:00:00Z' } : t)) };
    rerender(<HomeView onNavigate={() => {}} />);
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it('says when the read failed instead of claiming nothing happened', async () => {
    activity.mockImplementation(() => Promise.reject(new Error('500')));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.getByText(/Updates could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/Nothing new/)).toBeNull();
  });

  it('says so when nothing happened', async () => {
    activity.mockImplementation(() => Promise.resolve([]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.getByText('Nothing new on your tasks in the last 14 days.')).toBeTruthy();
  });

  it('is core: Tasks, Updates and Bookmarks lead Home whatever the saved layout', async () => {
    savedHome = { widgets: ['week'], introduced: ['updates'] };   // all three were taken off
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    // Every card has a heading (the Tasks title is a link inside its h2).
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Tasks', 'Updates', 'Bookmarks', 'Week Ahead']);
    expect(activity).toHaveBeenCalledTimes(1);
    const tasksCard = screen.getByText('Create Task');
    expect(tasksCard.compareDocumentPosition(screen.getByText('Updates')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-home-core]').dataset.homeCore).toBe('stacked');   // a phone
  });
});

describe('a grouped update', () => {
  const grouped = (over) => ({
    id: 'g1', type: 'attached', actorId: SAGAR, at: minutesAgo(5), detail: 'attached "a.png"',
    taskId: 't1', relation: 'assignee', entityTitle: 'Fix roof', forYou: false, preview: '', parts: [], ...over,
  });

  it('says everything one person did in one sentence', async () => {
    activity.mockImplementation(() => Promise.resolve([grouped({
      parts: [{ kind: 'status', count: 1, detail: 'changed status to in_progress' }, { kind: 'attached', count: 2, detail: '' },
        { kind: 'due', count: 1, detail: 'changed the due date from 10/20/2026 to 10/22/2026 - extension #1' }],
    })]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const row = document.querySelector('[data-update-row]');
    expect(row.textContent).toContain('Sagar P changed the status to In Progress, attached 2 files and pushed the due date to 10/22/2026');
    expect(row.hasAttribute('data-for-you')).toBe(false);
  });

  it('marks what is aimed at me, shows what was said, and For You narrows the list', async () => {
    activity.mockImplementation(() => Promise.resolve([
      // Pinned to calendar days, not "N hours ago" - CI runs at any hour and
      // 30 hours back is two days ago before 6 AM (failed on PR #680 at 00:53 UTC).
      grouped({ id: 'g1', at: new Date().toISOString(), forYou: true, preview: 'Can you check this, @Neil?',
        parts: [{ kind: 'mentioned_you', count: 1 }, { kind: 'commented', count: 1 }] }),
      grouped({ id: 'g2', taskId: 't2', relation: 'collaborator', at: yesterdayNoon(),
        parts: [{ kind: 'completed', count: 1 }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    let rows = document.querySelectorAll('[data-update-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Sagar P mentioned you in a comment');
    expect(rows[0].textContent).not.toContain('commented');            // the mention already says it
    expect(rows[0].textContent).toContain('Can you check this, @Neil?');
    expect(rows[0].hasAttribute('data-for-you')).toBe(true);
    expect(rows[1].textContent).toContain('completed this task');
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'For You (1)' }));
    rows = document.querySelectorAll('[data-update-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('mentioned you');
  });

  it('folds several people on one task into one row, never an ask', async () => {
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'a', actorId: SAGAR, at: minutesAgo(2), parts: [{ kind: 'commented', count: 1 }] }),
      grouped({ id: 'b', actorId: 'dean@greensglobal.com', at: minutesAgo(30), parts: [{ kind: 'commented', count: 2 }] }),
      grouped({ id: 'c', actorId: 'dean@greensglobal.com', at: minutesAgo(40), forYou: true, ask: 'open',
        parts: [{ kind: 'mentioned_you', count: 1 }, { kind: 'commented', count: 1 }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Sagar P and dean@greensglobal.com left 3 comments');
    expect(rows[1].textContent).toContain('mentioned you in a comment');
  });

  it('For You keeps what waits on me apart from what I answered', async () => {
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'x', at: minutesAgo(1), forYou: true, ask: 'Replied', parts: [{ kind: 'mentioned_you', count: 1 }] }),
      grouped({ id: 'y', taskId: 't2', at: minutesAgo(5), forYou: true, ask: 'open',
        parts: [{ kind: 'extension_ask', count: 1, detail: 'asked to extend the due date from 10/22/2026 to 10/30/2026 - extension #3, needs approval' }] }),
      grouped({ id: 'z', type: 'unblocked', at: minutesAgo(9), forYou: true, ask: '',
        parts: [{ kind: 'unblocked', count: 1, detail: 'Site survey', left: 0 }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'For You (2)' }));
    expect(screen.getByText('Waiting on You')).toBeTruthy();
    expect(screen.getByText('Answered')).toBeTruthy();
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows[0].textContent).toContain('asked you to approve an extension to 10/30/2026');
    expect(rows[1].textContent).toContain('finished Site survey, so this can start');
    expect(rows[2].hasAttribute('data-answered')).toBe(true);
    expect(rows[2].textContent).toContain('Replied');
  });

  it('says a repeat slip, who owns the task, and what is new since I last looked', async () => {
    seen.mockImplementation(() => Promise.resolve({ seenAt: minutesAgo(10) }));
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'n', at: minutesAgo(3), relation: 'owner',
        parts: [{ kind: 'due', count: 1, detail: 'changed the due date from 10/22/2026 to 10/30/2026 - extension #3' }] }),
      grouped({ id: 'o', taskId: 't2', at: minutesAgo(60), parts: [{ kind: 'due', count: 1, detail: 'changed the due date from 10/30/2026 to 10/24/2026' }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows[0].textContent).toContain('pushed the due date to 10/30/2026 for the 3rd time');
    expect(rows[0].textContent).toContain('You Own This');
    expect(rows[0].hasAttribute('data-new')).toBe(true);
    expect(rows[1].textContent).toContain('moved the due date up to 10/24/2026');
    expect(rows[1].hasAttribute('data-new')).toBe(false);
    expect(screen.getByText(/1 New/)).toBeTruthy();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('answers from the row: approve an extension, reply in the thread, like, resolve', async () => {
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'e', taskId: 't2', at: minutesAgo(1), forYou: true, ask: 'open',
        parts: [{ kind: 'extension_ask', count: 1, detail: 'asked to extend the due date from 10/22/2026 to 10/30/2026' }] }),
      grouped({ id: 'm', at: minutesAgo(2), forYou: true, ask: 'open', preview: 'Call the vendor',
        comment: { id: 'c1', threadId: 'c1', liked: false, canResolve: true },
        parts: [{ kind: 'comment_for_you', count: 1 }, { kind: 'commented', count: 1 }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const calls = activity.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await flush(); await flush();
    expect(respond).toHaveBeenCalledWith('t2', true);
    expect(activity.mock.calls.length).toBeGreaterThan(calls);   // read again: the server says what is answered

    fireEvent.click(screen.getByRole('button', { name: /Reply/ }));
    const box = screen.getByRole('textbox', { name: 'Reply' });
    fireEvent.change(box, { target: { value: 'On it <today>' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(reply).toHaveBeenCalledWith('t1', { body: '<p>On it &lt;today&gt;</p>', parent_id: 'c1' });
    expect(screen.queryByTestId('drawer')).toBeNull();   // typing in the box never opens the task

    fireEvent.click(screen.getByRole('button', { name: /Like/ }));
    await flush();
    expect(react).toHaveBeenCalledWith('c1', '👍');
    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));
    await flush();
    expect(editComment).toHaveBeenCalledWith('c1', { resolved: true });
  });

  it('opens the task at the comment, names the project, and dates older days', async () => {
    const old = new Date(); old.setDate(old.getDate() - 4); old.setHours(12, 0, 0, 0);
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'm', at: minutesAgo(2), forYou: true, ask: 'open', comment: { id: 'c9', threadId: 'c1', liked: false, canResolve: false },
        parts: [{ kind: 'mentioned_you', count: 1 }] }),
      grouped({ id: 'o', taskId: 't2', at: old.toISOString(), parts: [{ kind: 'completed', count: 1 }] }),
    ]));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const rows = document.querySelectorAll('[data-update-row]');
    expect(rows[0].querySelector('[data-update-project]').textContent).toBe('Operations');
    expect(screen.queryByText('Earlier')).toBeNull();
    const mm = String(old.getMonth() + 1).padStart(2, '0'); const dd = String(old.getDate()).padStart(2, '0');
    expect(screen.getByText(`${mm}/${dd}/${old.getFullYear()}`)).toBeTruthy();
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('drawer').textContent).toBe('t1@c9');
  });

  it('Load More reads further back', async () => {
    activity.mockImplementation(({ limit } = {}) => Promise.resolve(Array.from({ length: limit || 30 }, (_, i) => grouped({
      id: `l${i}`, taskId: `t${i + 10}`, at: minutesAgo(i + 1), parts: [{ kind: 'completed', count: 1 }] }))));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByText('Show All 30'));
    fireEvent.click(screen.getByText('Load More'));
    await flush();
    expect(activity).toHaveBeenLastCalledWith({ limit: 60 });
  });

  it('caps a stacked card at 8 with Show All, and a wide one scrolls instead', async () => {
    activity.mockImplementation(() => Promise.resolve(Array.from({ length: 11 }, (_, i) => grouped({
      // Eleven different tasks: one task's updates on one day fold into one row.
      id: `g${i}`, taskId: `t${i + 10}`, at: minutesAgo(i + 1), parts: [{ kind: 'completed', count: 1 }] }))));
    const { unmount } = render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(document.querySelectorAll('[data-update-row]')).toHaveLength(8);
    fireEvent.click(screen.getByText('Show All 11'));
    expect(document.querySelectorAll('[data-update-row]')).toHaveLength(11);
    unmount();

    mobile = false;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 1200, height: 400, top: 0, left: 0, right: 1200, bottom: 400, x: 0, y: 0 });
    try {
      render(<HomeView onNavigate={() => {}} />);
      await flush();
      expect(document.querySelector('[data-home-core]').dataset.homeCore).toBe('wide');
      expect(document.querySelectorAll('[data-update-row]')).toHaveLength(11);
      expect(screen.queryByText(/Show All/)).toBeNull();
    } finally {
      rect.mockRestore();
    }
  });
});
