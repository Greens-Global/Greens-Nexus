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
vi.mock('../api', () => ({ api: {
  getMyTaskActivity: () => Promise.resolve([]), markUpdatesSeen: () => Promise.resolve({ seenAt: '' }),
} }));
vi.mock('./myDay', () => ({ useMyDay: () => myDay }));
vi.mock('./TaskDetailDrawer', () => ({ default: ({ taskId }) => <div data-testid="drawer">{taskId}</div> }));
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
    fireEvent.click(within(tasksCard()).getByRole('button', { name: /View All \(15\)/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Move By Priority Up' }));
    expect(setHome.mock.calls.at(-1)[0].widgets).toEqual(['my_tasks', 'updates', 'projects', 'priorities', 'week']);
    expect(screen.getByRole('button', { name: 'Move Week Ahead Up' }).disabled).toBe(false);
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
