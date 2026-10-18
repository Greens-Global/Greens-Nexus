import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Tasks Home on a phone (Neil, Oct 14 2026): no summary tiles, the range
// picker in the Tasks card, and the Updates card - other people's recent
// changes to the tasks I am on - slotted in for saved layouts once.

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
    expect(rows[0].textContent).toContain('“Permit is approved”');
    expect(rows[1].textContent).toContain('Sagar P mentioned you');
    expect(rows[1].textContent).toContain('Other task');
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

  it('is slotted in after Tasks for a layout saved before it existed', async () => {
    savedHome = { widgets: ['my_tasks', 'week'] };
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    // The Tasks card's title is a button, so the headings start at Updates.
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Updates', 'Week Ahead']);
    const tasksCard = screen.getByText('Create Task');
    expect(tasksCard.compareDocumentPosition(screen.getByText('Updates')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays off once the person took it off', async () => {
    savedHome = { widgets: ['my_tasks', 'week'], introduced: ['updates'] };
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Updates');
    expect(activity).not.toHaveBeenCalled();
  });
});
