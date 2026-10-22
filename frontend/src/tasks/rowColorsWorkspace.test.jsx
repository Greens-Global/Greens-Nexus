import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';

// Row colors inside a project (Neil, Oct 22 2026): the project's rules color
// the list for everyone who opens it; only an editor (or a manager) gets Row
// Colors / Edit Rules - a viewer sees the colors and the key, no controls.

vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => Promise.resolve(k === 'getTaskTablePrefs' ? { prefs: {} } : [])) }),
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
const { __setTablePrefsCache } = await import('./tableCols');

beforeEach(() => { __setTablePrefsCache({}); });

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
