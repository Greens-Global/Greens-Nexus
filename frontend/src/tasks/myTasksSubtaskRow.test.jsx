import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// My Tasks, a subtask's row (Neil, Oct 22 2026: "subtasks have a project but
// the main one doesn't" - the parent's title read like a project). The
// project cell names the REAL project (the parent's) and, on its own line,
// "Subtask of: <parent>"; a subtask whose parent is not shared offers no
// project picker.

const DIRECTORY = [
  { email: 'it@greensglobal.com', name: 'Ira Tech' },
  { email: 'priya@greensglobal.com', name: 'Priya Rao' },
  { email: 'omar@greensglobal.com', name: 'Omar Diaz' },
];
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined
    : () => Promise.resolve(k === 'getTaskTablePrefs' ? { prefs: {} } : k === 'getPeopleDirectory' ? DIRECTORY : [])) }),
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

// Select All takes the rows on screen (11/17/2026): a folded group's rows are
// not, and a bulk Complete / Delete used to hit them all the same.
describe('My Tasks Select All', () => {
  const undated = (id, title) => ({ ...base, id, code: id, title, dueOn: '' });
  const later = (id, title) => ({ ...base, id, code: id, title, dueOn: '2999-01-01' });

  it('leaves out the rows of a folded group, and a row folded away leaves the batch', async () => {
    store = makeStore([undated('a', 'Alpha'), undated('b', 'Bravo'), later('c', 'Charlie')]);
    render(<MyTasksView />);
    await act(async () => { await Promise.resolve(); });
    // Fold "Do Later" (Charlie), then Select All.
    fireEvent.click(screen.getByRole('button', { name: /Do Later/ }));
    expect(screen.queryByText('Charlie')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    // Folding a group that holds picked rows takes them out of the batch.
    fireEvent.click(screen.getByRole('button', { name: /Recently Assigned/ }));
    expect(screen.queryByText(/ selected$/)).toBeNull();
    // The folds are kept per person: open them again for the tests below.
    fireEvent.click(screen.getByRole('button', { name: /Recently Assigned/ }));
    fireEvent.click(screen.getByRole('button', { name: /Do Later/ }));
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });
});

// The row's Add Collaborators searches the curated Nexus People list
// (11/17/2026) - it only knew people already on a task or a project.
describe('My Tasks row collaborator picker', () => {
  it('offers everyone in Nexus People but me, and still lists someone already on the task', async () => {
    const t = { ...base, id: 'a', code: 'a', title: 'Alpha', followerIds: ['partner@outside.com'] };
    store = makeStore([t]);
    render(<MyTasksView />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(within(screen.getByText('Alpha').closest('[data-task-row]')).getByTitle('Add Collaborators'));
    const menu = screen.getByPlaceholderText('Search people…').closest('[role="dialog"]');
    expect(within(menu).getByText('Priya Rao')).toBeInTheDocument();
    expect(within(menu).getByText('Omar Diaz')).toBeInTheDocument();
    expect(within(menu).queryByText('Ira Tech')).toBeNull();          // me
    expect(within(menu).getByText('partner@outside.com')).toBeInTheDocument();
  });
});
