import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';

// Row colors inside a project (Neil, Oct 22 2026): the project's rules color
// the list for everyone who opens it; only an editor (or a manager) gets Row
// Colors / Edit Rules - a viewer sees the colors and the key, no controls.

const saveTaskTablePrefs = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined
    : k === 'saveTaskTablePrefs' ? (...a) => saveTaskTablePrefs(...a)
      : () => Promise.resolve(k === 'getTaskTablePrefs' ? { prefs: {} } : [])) }),
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }));

const ME = 'me@greensglobal.com';
const RULES = [{ id: 'r1', name: 'Overdue', color: 'red', bold: false, enabled: true, match: 'all', conditions: [{ field: 'due', op: 'overdue' }] }];
const base = { status: 'not_started', priority: 'medium', assigneeIds: [], followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, customFieldValues: {}, projectId: 'p1', startOn: '' };
const tasks = [
  { ...base, id: 't1', code: 'T-1', title: 'Late one', dueOn: '2020-01-01' },
  { ...base, id: 't2', code: 'T-2', title: 'On time', dueOn: '' },
];
const project = (role) => ({
  id: 'p1', name: 'Ops', ownerId: 'boss@greensglobal.com', accessLevel: 'restricted',
  memberIds: [ME], memberRoles: { [ME]: role }, colorRules: RULES, colorRulesRev: 'rev-1',
});
let store;
const makeStore = (role) => {
  const p = project(role);
  const statusMeta = { not_started: { label: 'Not Started', color: '#888' }, in_progress: { label: 'In Progress', color: '#48f' }, completed: { label: 'Completed', color: '#4a4' } };
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: [p], teams: [], portfolios: [], sections: [],
    customFields: [], customStatuses: [], savedViews: [], templates: [], intakeForms: [], bookmarks: new Set(), loading: false, myEmail: ME,
    statusMeta, statusOrder: ['not_started', 'in_progress', 'completed'], statusOrderFor: () => ['not_started', 'in_progress', 'completed'],
    nameOf: (e) => e, projectName: () => 'Ops', teamName: () => '', teamById: () => null,
    projectById: (id) => (id === 'p1' ? p : null), portfolioById: () => null,
    toggleComplete: () => {}, toggleBookmark: () => Promise.resolve(), updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
    setStatus: () => {}, updateProject: () => Promise.resolve(p),
    saveColorRules: vi.fn(() => Promise.resolve(p)),
  };
};
vi.mock('./TasksContext', async (importOriginal) => ({ ...(await importOriginal()), useTasks: () => store }));

const { default: TasksWorkspace } = await import('./TasksWorkspace');
const { default: MyTasksView } = await import('./MyTasksView');
const { __setTablePrefsCache } = await import('./tableCols');

beforeEach(() => { __setTablePrefsCache({}); saveTaskTablePrefs.mockReset(); saveTaskTablePrefs.mockImplementation(() => Promise.resolve({})); });

describe('Row colors in a project', () => {
  it('a viewer sees the colored rows and the key, but no Row Colors and no Edit Rules', () => {
    store = makeStore('viewer');
    render(<TasksWorkspace lockedProjectId="p1" />);
    expect(screen.getByText('Late one').closest('[data-task-row]').className).toContain('nx-rc');
    expect(screen.getByText('On time').closest('[data-task-row]').className).not.toContain('nx-rc');
    const key = screen.getByTestId('row-color-legend');
    expect(within(key).getByText('Overdue')).toBeInTheDocument();
    expect(within(key).getByRole('switch', { name: 'Show Row Colors' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Row Colors/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit Rules/ })).toBeNull();
  });

  it('an editor opens the editor and a change is saved with the rev it was read at', async () => {
    store = makeStore('editor');
    render(<TasksWorkspace lockedProjectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: /Row Colors/ }));
    expect(screen.getByText('Row Colors - Ops')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Turn off Overdue' })); });
    expect(store.saveColorRules).toHaveBeenCalledWith('p1', [expect.objectContaining({ id: 'r1', enabled: false })], 'rev-1');
  });
});

describe('My Tasks: the person\'s own rules', () => {
  const mineTasks = tasks.map((t) => ({ ...t, assigneeIds: [ME], assigneeId: ME }));
  const myStore = () => ({ ...makeStore('editor'), tasks: mineTasks, taskById: Object.fromEntries(mineTasks.map((t) => [t.id, t])) });
  const PERSONAL = [{ id: 'm1', name: 'Mine Late', color: 'pink', bold: false, enabled: true, match: 'all', conditions: [{ field: 'due', op: 'overdue' }] }];

  it('colors My Tasks rows from the profile, with a key', () => {
    store = myStore();
    __setTablePrefsCache({ rowColors: { data: { mine: PERSONAL } } });
    render(<MyTasksView />);
    expect(screen.getByText('Late one').closest('[data-task-row]').getAttribute('data-row-color')).toBe('m1');
    expect(within(screen.getByTestId('row-color-legend')).getByText('Mine Late')).toBeInTheDocument();
  });

  it('a malformed document does not take the screen down', () => {
    store = myStore();
    __setTablePrefsCache({ rowColors: { data: { mine: [null, 'x', { id: 'bad' }, { ...PERSONAL[0], conditions: 'nope' }, PERSONAL[0]] } } });
    render(<MyTasksView />);
    expect(screen.getByText('Late one').closest('[data-task-row]').getAttribute('data-row-color')).toBe('m1');
    __setTablePrefsCache({ rowColors: { data: 'garbage' } });
    expect(screen.getByText('Late one')).toBeInTheDocument();
  });

  it('a save the server refuses puts the previous rules back and says why', async () => {
    store = myStore();
    __setTablePrefsCache({ rowColors: { data: { mine: PERSONAL } } });
    saveTaskTablePrefs.mockImplementationOnce(() => Promise.reject(new Error('Rule 1: pick a color from the palette')));
    render(<MyTasksView />);
    fireEvent.click(screen.getByRole('button', { name: /Row Colors/ }));
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Turn off Mine Late' })); });
    expect(screen.getByRole('alert').textContent).toContain('pick a color');
    // The failed write was followed by one that puts the old rules back.
    expect(saveTaskTablePrefs).toHaveBeenLastCalledWith('rowColors', { data: { mine: PERSONAL } });
    expect(screen.getByRole('switch', { name: 'Turn off Mine Late' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Late one').closest('[data-task-row]').getAttribute('data-row-color')).toBe('m1');
  });
});
