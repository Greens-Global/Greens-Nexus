import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Tasks Home at a desk after the Oct 23 2026 pass (Neil): four tiles that say
// what they mean and switch the Tasks card, the dashboard's own "need you
// now" line, a Tasks card grouped by day with a cap and a folded No Due Date,
// charts that filter it, Projects at Risk, Team Workload, My Day, a
// Customize that works without a mouse, and Notifications no longer offered.

let store;
let savedHome;
const setHome = vi.fn();
const mineView = vi.fn();
const myDay = { status: 'ready', total: 0, open: [], done: [] };

vi.mock('./TasksContext', () => ({ useTasks: () => store }));
// The Updates feed: empty unless a test fills it (or makes it fail).
let activity = () => Promise.resolve([]);
vi.mock('../api', () => ({ api: {
  getMyTaskActivity: (...a) => activity(...a), markUpdatesSeen: () => Promise.resolve({ seenAt: '' }),
} }));
vi.mock('./myDay', () => ({ useMyDay: () => myDay }));
vi.mock('./TaskDetailDrawer', () => ({ default: ({ taskId }) => <div data-testid="drawer">{taskId}</div> }));
// Add Several is its own tested surface; here only that the add row opens it with the right defaults.
vi.mock('./AddSeveralModal', () => ({ default: ({ defaults, onDone, onClose }) => (
  <div data-testid="add-several" data-defaults={JSON.stringify(defaults)}>
    <button type="button" onClick={() => { onDone?.({ created: 3, topLevelIds: ['a', 'b'] }); onClose?.(true); }}>Finish Several</button>
  </div>
) }));
vi.mock('./ManageView', () => ({ DeletedTasksTab: () => null }));
vi.mock('../components/AnchoredMenu', () => ({ default: ({ open, children }) => (open ? <div>{children}</div> : null) }));
vi.mock('./components', async (orig) => {
  const real = await orig();
  return { ...real, useIsMobile: () => false, Avatar: ({ name }) => <span data-avatar>{name}</span> };
});
vi.mock('./tableCols', async (orig) => {
  const real = await orig();
  return {
    ...real,
    whenTablePrefsLoaded: () => Promise.resolve({ prefs: {}, fromServer: true }),
    useTableValue: (table, name, fallback) => {
      const [v, setV] = useState(table === 'home' ? savedHome : fallback);
      return [v, (next) => { if (table === 'home') setHome(next); if (table === 'mytasks') mineView(next); setV(next); }];
    },
  };
});

const { default: HomeView } = await import('./HomeView');
const { localISO, addDays, dayTitle } = await import('./homeRules');

const ME = 'neil@greensglobal.com';
const SAGAR = 'sagar@greensglobal.com';
const TODAY = localISO(new Date());
let n = 0;
const task = (o) => ({ id: `t${++n}`, title: `Task ${n}`, type: 'task', status: 'not_started', completed: false, assigneeIds: [ME], ...o });

beforeEach(() => {
  n = 0;
  savedHome = undefined;
  activity = () => Promise.resolve([]);
  setHome.mockClear();
  mineView.mockClear();
  Object.assign(myDay, { status: 'ready', total: 0, open: [], done: [] });
  store = {
    tasks: [], projects: [], teams: [], notifications: [], bookmarks: new Set(), loading: false,
    projectName: (id) => (store.projects.find((p) => p.id === id) || {}).name || '',
    myEmail: ME, nameOf: (e) => ({ [SAGAR]: 'Sagar P', [ME]: 'Neil K' }[e] || ''),
    statusMeta: {}, createTask: vi.fn(), toggleComplete: vi.fn(), markNotificationRead: vi.fn(),
  };
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const tasksCard = () => document.querySelector('[data-home-tasks]');

describe('Tasks Home tiles', () => {
  it('count overdue, today, the week and in progress, and say what needs you now', async () => {
    store.tasks = [
      task({ dueOn: addDays(TODAY, -2) }), task({ dueOn: TODAY }), task({ dueOn: addDays(TODAY, 3) }),
      task({ status: 'in_progress' }), task({ dueOn: '' }), task({ status: 'recurring', dueOn: addDays(TODAY, 9) }),
      task({ dueOn: TODAY, completed: true }),
    ];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const tile = (title) => screen.getByTitle(title);
    expect(within(tile('Show overdue tasks')).getByText('1')).toBeTruthy();
    expect(within(tile('Show tasks due today')).getByText('1')).toBeTruthy();
    expect(within(tile('Show tasks due in the next 7 days')).getByText('2')).toBeTruthy();
    expect(within(tile('Show tasks in progress')).getByText('1')).toBeTruthy();
    // overdue + today + week + in progress = 4; one undated, one repeating ahead.
    expect(screen.getByText('4 need you now')).toBeTruthy();
    expect(screen.getByText(/\+1 with no due date, \+1 recurring/)).toBeTruthy();
    expect(screen.queryByText(/\/\d+ tasks/)).toBeNull();   // no "/N" fractions any more
  });

  it('switch the Tasks card', async () => {
    store.tasks = [task({ title: 'Late one', dueOn: addDays(TODAY, -2) }), task({ title: 'Doing it', status: 'in_progress' })];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByTitle('Show overdue tasks'));
    expect(screen.getByRole('tab', { name: 'Overdue (1)' }).getAttribute('aria-selected')).toBe('true');
    expect(within(tasksCard()).getByText('Late one')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Show tasks in progress'));
    expect(screen.getByRole('tab', { name: 'In Progress (1)' }).getAttribute('aria-selected')).toBe('true');
    expect(within(tasksCard()).getByText('Doing it')).toBeTruthy();
    expect(screen.getByTitle('Show tasks in progress').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the Tasks card', () => {
  it('groups by day, shows project, priority and repeat, and folds No Due Date', async () => {
    store.projects = [{ id: 'p1', name: 'Operations' }];
    store.tasks = [
      task({ title: 'Ship it', dueOn: TODAY, priority: 'urgent', projectId: 'p1' }),
      task({ title: 'Call back', dueOn: addDays(TODAY, 1), recurrence: { freq: 'weekly' } }),
      task({ title: 'Someday', dueOn: '' }),
    ];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const card = within(tasksCard());
    expect(card.getByText('Today')).toBeTruthy();
    expect(card.getByText('Tomorrow')).toBeTruthy();
    expect(card.getByText('Operations')).toBeTruthy();
    expect(card.getByLabelText('Urgent priority')).toBeTruthy();
    expect(card.getByLabelText('Repeats')).toBeTruthy();
    expect(card.queryByText('Someday')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: /No Due Date/ }));
    expect(card.getByText('Someday')).toBeTruthy();
  });

  it('caps the list with View All, which opens My Tasks on its list', async () => {
    store.tasks = Array.from({ length: 15 }, () => task({ dueOn: TODAY }));
    const onNavigate = vi.fn();
    render(<HomeView onNavigate={onNavigate} />);
    await flush();
    expect(tasksCard().querySelectorAll('[data-task-row]')).toHaveLength(12);
    fireEvent.click(within(tasksCard()).getByRole('button', { name: /3 More in My Tasks/ }));
    expect(mineView).toHaveBeenCalledWith('list');
    expect(onNavigate).toHaveBeenCalledWith('mine');
  });
});

describe('the charts filter the Tasks card', () => {
  it('a Week Ahead day shows that day, with a chip that clears it', async () => {
    const day = addDays(TODAY, 2);
    store.tasks = [task({ title: 'That day', dueOn: day }), task({ title: 'Other day', dueOn: TODAY })];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: `${dayTitle(day)}: 1 due` }));
    const card = within(tasksCard());
    expect(card.getByText('That day')).toBeTruthy();
    expect(card.queryByText('Other day')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Clear Filter' }));
    expect(card.getByText('Other day')).toBeTruthy();
  });

  it('a By Priority bar shows that priority', async () => {
    store.tasks = [task({ title: 'Hot', priority: 'urgent', dueOn: '' }), task({ title: 'Cool', priority: 'low', dueOn: TODAY })];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByTitle('Show your open Urgent priority tasks'));
    const card = within(tasksCard());
    expect(card.getByText('Urgent Priority')).toBeTruthy();
    expect(card.getByText('Hot')).toBeTruthy();
    expect(card.queryByText('Cool')).toBeNull();
  });
});

describe('widgets', () => {
  it('the default Home carries My Day, Week Ahead, Projects at Risk and By Priority', async () => {
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    for (const title of ['My Day', 'Week Ahead', 'Projects at Risk', 'By Priority']) expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Completed This Week' })).toBeNull();
  });

  it('a saved layout is kept as it is', async () => {
    savedHome = { widgets: ['my_tasks', 'updates', 'projects', 'activity', 'notifications'] };
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    expect(screen.getByRole('heading', { name: 'Completed This Week' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'My Day' })).toBeNull();
  });

  it('Projects at Risk lists only my projects with late or due-soon work', async () => {
    store.projects = [{ id: 'p1', name: 'Rollout', ownerId: ME }, { id: 'p2', name: 'Elsewhere' }];
    store.tasks = [task({ projectId: 'p1', dueOn: addDays(TODAY, -1), assigneeIds: [SAGAR] }), task({ projectId: 'p2', dueOn: addDays(TODAY, -1), assigneeIds: [SAGAR] })];
    const onNavigate = vi.fn();
    render(<HomeView onNavigate={onNavigate} />);
    await flush();
    fireEvent.click(screen.getByText('Rollout'));
    expect(onNavigate).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(screen.getByText('1 Overdue')).toBeTruthy();
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('Team Workload shows each teammate and opens their tasks', async () => {
    savedHome = { widgets: ['my_tasks', 'updates', 'projects', 'team_members'] };
    store.teams = [{ id: 'd1', name: 'Ops', memberIds: [ME, SAGAR] }];
    store.tasks = [task({ assigneeIds: [SAGAR], dueOn: addDays(TODAY, -3) }), task({ assigneeIds: [SAGAR] })];
    const seen = vi.fn();
    window.addEventListener('nexus:tasks-person', seen);
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const row = screen.getByTitle(/2 open, 1 overdue, 0 due this week/);
    fireEvent.click(row);
    expect(seen.mock.calls[0][0].detail).toEqual({ email: SAGAR, name: 'Sagar P' });
    window.removeEventListener('nexus:tasks-person', seen);
  });

  it('My Day shows progress and opens the My Day tab', async () => {
    Object.assign(myDay, { total: 3, open: [task({ title: 'First thing' })], done: [task({ completed: true }), task({ completed: true })] });
    const onNavigate = vi.fn();
    render(<HomeView onNavigate={onNavigate} />);
    await flush();
    expect(screen.getByText('2 of 3 done')).toBeTruthy();
    expect(screen.getByText('First thing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open My Day/ }));
    expect(mineView).toHaveBeenCalledWith('myday');
    expect(onNavigate).toHaveBeenCalledWith('mine');
  });

  it('a notification row opens its task and marks it read', async () => {
    savedHome = { widgets: ['my_tasks', 'updates', 'projects', 'notifications'] };
    store.notifications = [{ id: 'n1', title: 'Assigned to you', body: 'Fix roof', taskId: 't9', read: false, createdAt: new Date().toISOString() }];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByText('Assigned to you'));
    expect(store.markNotificationRead).toHaveBeenCalledWith('n1');
    expect(screen.getByTestId('drawer').textContent).toBe('t9');
  });
});

describe('Customize', () => {
  const enter = async () => {
    const slot = document.createElement('div');
    slot.id = 'nx-tasks-bar-actions';
    document.body.appendChild(slot);
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    return () => slot.remove();
  };

  it('moves a widget without dragging', async () => {
    savedHome = { widgets: ['my_tasks', 'updates', 'projects', 'week', 'priorities'] };
    const done = await enter();
    fireEvent.click(screen.getByRole('button', { name: 'Move By Priority Earlier' }));
    expect(setHome.mock.calls.at(-1)[0].widgets).toEqual(['my_tasks', 'updates', 'projects', 'priorities', 'week']);
    expect(screen.getByRole('button', { name: 'Move Week Ahead Earlier' }).disabled).toBe(false);
    done();
  });

  it('offers widgets with a line each, and no longer offers Notifications', async () => {
    savedHome = { widgets: ['my_tasks', 'updates', 'projects'] };
    const done = await enter();
    expect(screen.getByText('Add Widgets')).toBeTruthy();
    expect(screen.getByText('Open and overdue work for each teammate.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Notifications/ })).toBeNull();
    done();
  });
});

describe('quick add', () => {
  it('Enter saves once, and the title is cleared before the save returns', async () => {
    let resolve;
    store.createTask = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Create Task/ }));
    const box = screen.getByRole('textbox', { name: 'Task Name' });
    fireEvent.change(box, { target: { value: 'Call the inspector' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.pointerDown(document.body);           // a click-away right after
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.createTask.mock.calls[0][0]).toMatchObject({ title: 'Call the inspector', dueOn: '' });
    expect(box.value).toBe('');
    await act(async () => { resolve({ id: 'new' }); });
  });

  it('a pasted list opens Add Several with the typed text first, and the new undated tasks are shown', async () => {
    store.createTask = vi.fn(() => Promise.resolve({ id: 'new' }));
    store.tasks = [task({ title: 'Undated one', dueOn: '' })];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Create Task/ }));
    const box = screen.getByRole('textbox', { name: 'Task Name' });
    fireEvent.change(box, { target: { value: 'Typed first' } });
    fireEvent.paste(box, { clipboardData: { getData: () => 'Call the bank\nFile the receipts' } });
    const modal = await screen.findByTestId('add-several');
    const d = JSON.parse(modal.dataset.defaults);
    expect(d).toMatchObject({ text: 'Typed first\nCall the bank\nFile the receipts', dueOn: '', assigneeIds: [ME], source: 'paste' });
    expect(store.createTask).not.toHaveBeenCalled();
    expect(screen.queryByText('Undated one')).toBeNull();   // folded under No Due Date
    fireEvent.click(screen.getByRole('button', { name: 'Finish Several' }));
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('2 tasks added');
    expect(screen.getByText('Undated one')).toBeTruthy();   // the fold opened
  });

  it('a one-line paste types in as before', async () => {
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Create Task/ }));
    const box = screen.getByRole('textbox', { name: 'Task Name' });
    const out = fireEvent.paste(box, { clipboardData: { getData: () => 'Just one\n' } });
    expect(out).toBe(true);
    expect(screen.queryByTestId('add-several')).toBeNull();
  });

  it('a click outside the row saves; a click inside it does not', async () => {
    store.createTask = vi.fn(() => Promise.resolve({ id: 'new' }));
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Create Task/ }));
    const box = screen.getByRole('textbox', { name: 'Task Name' });
    fireEvent.change(box, { target: { value: 'Order parts' } });
    fireEvent.pointerDown(screen.getByTitle('Set Due Date'));   // the date button, inside the row
    expect(store.createTask).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(store.createTask).toHaveBeenCalledTimes(1);
  });
});

describe('keyboard', () => {
  it('arrow keys move between the Tasks tabs, and a row opens with Enter', async () => {
    store.tasks = [task({ title: 'Open me', dueOn: TODAY })];
    render(<HomeView onNavigate={() => {}} />);
    await flush();
    const upcoming = screen.getByRole('tab', { name: 'Upcoming' });
    fireEvent.keyDown(upcoming, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overdue' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overdue' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open Open me' }), { key: 'Enter' });
    expect(screen.getByTestId('drawer').textContent).toBe(store.tasks[0].id);
  });
});

// The core at a desk (Neil, 10/31/2026): Updates leads - the left column for
// the full height of Tasks + Bookmarks, and first in the DOM - unless the
// feed has loaded with nothing in it, when Tasks keeps the left column.
describe('the core at a desk', () => {
  const update = (over) => ({
    id: 'g1', type: 'attached', actorId: SAGAR, at: new Date(Date.now() - 5 * 60e3).toISOString(), detail: 'attached "a.png"',
    taskId: 't1', relation: 'assignee', entityTitle: 'Fix roof', forYou: false, preview: '', parts: [], ...over,
  });
  const wide = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 1200, height: 400, top: 0, left: 0, right: 1200, bottom: 400, x: 0, y: 0 });
  const h2s = () => [...document.querySelectorAll('[data-home-core] h2')].map((h) => h.textContent);
  const core = () => document.querySelector('[data-home-core]');

  it('Updates leads when there is anything in the feed, filling its column', async () => {
    activity = () => Promise.resolve([update()]);
    const rect = wide();
    try {
      render(<HomeView onNavigate={() => {}} />);
      await flush();
      expect(core().dataset.homeCore).toBe('wide');
      expect(core().dataset.homeCoreLead).toBe('updates');
      expect(h2s()).toEqual(['Updates', 'Tasks', 'Bookmarks']);
      expect(core().style.gridTemplateAreas).toBe('"updates tasks" "updates bookmarks"');
      // The fill column: Updates sits in the absolute box that spans the other two.
      const column = screen.getByText('Updates').closest('[style*="position: absolute"]');
      expect(column).toBeTruthy();
      expect(column.parentElement.style.gridArea).toBe('updates');
      expect(screen.getByText('Fix roof')).toBeTruthy();
    } finally { rect.mockRestore(); }
  });

  it('Tasks keeps the left column when the feed has loaded empty', async () => {
    const rect = wide();
    try {
      render(<HomeView onNavigate={() => {}} />);
      await flush();
      expect(core().dataset.homeCore).toBe('wide');
      expect(core().dataset.homeCoreLead).toBe('tasks');
      expect(h2s()).toEqual(['Tasks', 'Updates', 'Bookmarks']);
      expect(core().style.gridTemplateAreas).toBe('"tasks updates" "bookmarks updates"');
    } finally { rect.mockRestore(); }
  });

  it('a feed that could not be read still leads: the notice is worth seeing', async () => {
    activity = () => Promise.reject(new Error('down'));
    const rect = wide();
    try {
      render(<HomeView onNavigate={() => {}} />);
      await flush();
      expect(core().dataset.homeCoreLead).toBe('updates');
      expect(h2s()[0]).toBe('Updates');
      expect(screen.getByText(/Updates could not be loaded/)).toBeTruthy();
    } finally { rect.mockRestore(); }
  });
});
