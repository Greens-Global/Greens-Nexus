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

vi.mock('./TasksContext', () => ({ useTasks: () => store }));
vi.mock('../api', () => ({ api: { getMyTaskActivity: (...a) => activity(...a) } }));
vi.mock('./TaskDetailDrawer', () => ({ default: ({ taskId }) => <div data-testid="drawer">{taskId}</div> }));
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

beforeEach(() => {
  mobile = true;
  savedHome = undefined;
  activity.mockReset();
  activity.mockImplementation(() => Promise.resolve([
    { id: 'a1', type: 'status_changed', actorId: SAGAR, at: minutesAgo(5), detail: 'changed status to in_progress', taskId: 't1', relation: 'assignee', entityTitle: 'Fix roof' },
    { id: 'a2', type: 'commented', actorId: SAGAR, at: minutesAgo(180), detail: 'added a comment', taskId: 't2', relation: 'collaborator', entityTitle: 'Paint fence' },
  ]));
  store = {
    tasks: [
      { id: 't1', title: 'Fix roof', type: 'task', assigneeIds: [ME], dueOn: '2099-01-01', completed: false },
      { id: 't2', title: 'Paint fence', type: 'task', assigneeIds: [SAGAR], followerIds: [ME], completed: false },
    ],
    projects: [], teams: [], notifications: [], bookmarks: new Set(), loading: false,
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
    expect(screen.queryByTitle('Open my tasks')).toBeNull();          // the Priority tile
    expect(screen.queryByText('Priority')).toBeNull();
    const picker = screen.getByText('My Week');
    expect(picker.closest('div').parentElement.textContent).toContain('Tasks');
    fireEvent.click(picker);
    fireEvent.click(screen.getByText('My Day'));
    expect(screen.queryByText('My Month')).toBeNull();                 // the menu closed...
    expect(screen.getByText('My Day').tagName).toBe('BUTTON');         // ...and the pick is on the button
    expect(screen.queryByText('My Week')).toBeNull();
  });

  it('keeps the tiles at a desk', async () => {
    mobile = false;
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.getByTitle('Open my tasks')).toBeTruthy();
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
    // The Tasks card's title is a button, so the headings start at Updates.
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Updates', 'Bookmarks', 'Week Ahead']);
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
    expect(row.textContent).toContain('Sagar P changed the status to In Progress, attached 2 files and moved the due date to 10/22/2026');
    expect(row.hasAttribute('data-for-you')).toBe(false);
  });

  it('marks what is aimed at me, shows what was said, and For You narrows the list', async () => {
    activity.mockImplementation(() => Promise.resolve([
      grouped({ id: 'g1', forYou: true, preview: 'Can you check this, @Neil?',
        parts: [{ kind: 'mentioned_you', count: 1 }, { kind: 'commented', count: 1 }] }),
      grouped({ id: 'g2', taskId: 't2', relation: 'collaborator', at: minutesAgo(60 * 30),
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

  it('caps a stacked card at 8 with Show All, and a wide one scrolls instead', async () => {
    activity.mockImplementation(() => Promise.resolve(Array.from({ length: 11 }, (_, i) => grouped({
      id: `g${i}`, at: minutesAgo(i + 1), parts: [{ kind: 'attached', count: 1 }] }))));
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
