import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// My Tasks, a subtask's row (Neil, Oct 22 2026: "subtasks have a project but
// the main one doesn't" - the parent's title read like a project). The
// project cell names the REAL project (the parent's) and, on its own line,
// "Subtask of: <parent>"; a subtask whose parent is not shared offers no
// project picker.

vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined
    : () => Promise.resolve(k === 'getTaskTablePrefs' ? { prefs: {} } : [])) }),
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }));

const ME = 'it@greensglobal.com';
const base = { status: 'not_started', priority: 'medium', assigneeIds: [ME], assigneeId: ME, followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, customFieldValues: {}, projectId: '', startOn: '', dueOn: '' };
const parent = { ...base, id: 'p', code: 'T-1', title: 'Onboarding - Jane Doe', projectId: 'hr', assigneeIds: ['hr@greensglobal.com'], assigneeId: 'hr@greensglobal.com', subtaskIds: ['s1'] };
const sub = { ...base, id: 's1', code: 'T-2', title: 'Laptop Shipped - Jane Doe', parentTaskId: 'p' };
const orphan = { ...base, id: 's2', code: 'T-3', title: 'Badge Printed - Sam Lee', parentTaskId: 'hidden' };
let store;
const makeStore = (tasks) => ({
  tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: [{ id: 'hr', name: '#General - Human Resources', memberIds: [] }],
  teams: [], portfolios: [], sections: [], customFields: [], customStatuses: [], savedViews: [], templates: [], intakeForms: [],
  bookmarks: new Set(), loading: false, myEmail: ME,
  statusMeta: { not_started: { label: 'Not Started', color: '#888' }, completed: { label: 'Completed', color: '#4a4' } },
  statusOrder: ['not_started', 'completed'], statusOrderFor: () => ['not_started', 'completed'],
  nameOf: (e) => e, projectName: (id) => (id === 'hr' ? '#General - Human Resources' : ''), teamName: () => '', teamById: () => null,
  projectById: () => null, portfolioById: () => null,
  toggleComplete: () => {}, toggleBookmark: () => Promise.resolve(), updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
  setStatus: () => {}, updateProject: () => Promise.resolve({}),
});
vi.mock('./TasksContext', async (importOriginal) => ({ ...(await importOriginal()), useTasks: () => store }));

const { default: MyTasksView } = await import('./MyTasksView');

describe('My Tasks subtask row', () => {
  it('shows the inherited project and "Subtask of" the parent, on separate lines', () => {
    store = makeStore([parent, sub, orphan]);
    render(<MyTasksView />);
    expect(screen.getByText('Laptop Shipped - Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Subtask of: Onboarding - Jane Doe')).toBeInTheDocument();
    expect(screen.getAllByText('#General - Human Resources').length).toBeGreaterThan(0);
    // its parent is not shared: a plain "Subtask" label, no project picker on it
    const row = screen.getByText('Badge Printed - Sam Lee').closest('[data-task-row]');
    expect(row.textContent).toContain('Subtask');
    expect(row.textContent).not.toContain('No project');
  });
});
