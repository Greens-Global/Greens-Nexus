import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { taskRoleFor } from './lib';

// The task drawer offers only what the caller's role on the task's project
// allows (Oct 21 2026) - the server's rule (task_util.require_task_role):
// viewer = read only; commenter = comment, attach, log time; editor and up =
// everything; managers and assignees always edit. Unknown keeps every control.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const apiOverride = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => apiOverride[k] || (() => Promise.resolve([])) }) }));
let manager = false;
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => manager }),
}));

const ME = 'me@x.com';
const project = (role) => ({
  id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted', timeTracking: 'on',
  memberIds: [ME], memberRoles: role ? { [ME]: role } : {},
});
const task = {
  id: 't1', title: 'Fix the pump', status: 'not_started', priority: 'medium', projectId: 'p1', parentTaskId: '',
  assigneeIds: ['other@x.com'], subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [],
  customFieldValues: {}, completed: false, description: '<p>Replace the seal</p>',
};

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
function makeStore({ role = 'viewer', projects, t = task } = {}) {
  return {
    tasks: [t], taskById: { [t.id]: t }, teams: [], projects: projects || [project(role)], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false, runningTimer: null,
    projectName: () => 'Plant', teamName: () => '', nameOf: (e) => e, myEmail: ME,
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
    getComments: vi.fn(() => Promise.resolve([])), addComment: vi.fn(), offerUndo: vi.fn(),
    toggleComplete: vi.fn(() => Promise.resolve()), refresh: vi.fn(), applyServerTask: vi.fn(),
    startTimer: vi.fn(), stopTimer: vi.fn(),
  };
}

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

beforeEach(() => {
  manager = false;
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const titleBox = () => screen.getByLabelText('Task name');
const openTime = () => fireEvent.click(screen.getByText('Time Tracking'));

describe('taskRoleFor', () => {
  const base = { projects: [project('viewer')], teams: [], taskById: {}, email: ME };
  it('reads the project role, raised by an approved team and by being assigned', () => {
    expect(taskRoleFor(task, base)).toBe('viewer');
    const team = { id: 'tm', projectIds: ['p1'], memberIds: [ME], accessRole: 'commenter', approvalStatus: 'approved' };
    expect(taskRoleFor(task, { ...base, teams: [team] })).toBe('commenter');
    expect(taskRoleFor(task, { ...base, teams: [{ ...team, approvalStatus: 'pending' }] })).toBe('viewer');
    expect(taskRoleFor({ ...task, assigneeIds: [ME] }, base)).toBe('editor');
  });
  it('managers are owners, a task with no project is editable, and unknown is null', () => {
    expect(taskRoleFor(task, { ...base, isManager: true })).toBe('owner');
    expect(taskRoleFor({ ...task, projectId: '' }, base)).toBe('editor');
    expect(taskRoleFor(task, { ...base, projects: [] })).toBeNull();
    expect(taskRoleFor({ ...task, projectId: '', parentTaskId: 'gone' }, base)).toBeNull();
    expect(taskRoleFor(task, { ...base, projects: [project('weird')] })).toBeNull();
  });
});

describe('the drawer by role', () => {
  it('a viewer gets read-only fields, no comment box, no attach, no timer', () => {
    state = makeStore({ role: 'viewer' });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.getByTestId('view-only-note').textContent).toMatch(/You can view this task/);
    expect(titleBox().readOnly).toBe(true);
    expect(screen.getByTestId('fields-read-only').disabled).toBe(true);
    expect(screen.getByTestId('description-read-only').textContent).toBe('Replace the seal');
    expect(screen.queryByTitle('Share')).toBeNull();
    expect(screen.getByTitle('You can view this task but not change it').disabled).toBe(true);
    expect(screen.queryByText('Attach File')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    openTime();
    expect(screen.queryByRole('button', { name: /Start Timer/ })).toBeNull();
    fireEvent.click(screen.getByTitle('More Actions'));
    expect(screen.queryByText('Delete Task')).toBeNull();
    expect(screen.queryByText('Duplicate Task')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Comments' })[0]);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('a commenter can comment, attach and log time, but not edit fields', () => {
    state = makeStore({ role: 'commenter' });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.getByTestId('view-only-note').textContent).toMatch(/comment on this task, attach files and log time/);
    expect(screen.getByTestId('fields-read-only').disabled).toBe(true);
    expect(screen.getByText('Attach File')).toBeInTheDocument();
    openTime();
    expect(screen.getByRole('button', { name: /Start Timer/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Comments' })[0]);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('an editor gets everything, as before', () => {
    state = makeStore({ role: 'editor' });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('view-only-note')).toBeNull();
    expect(screen.queryByTestId('fields-read-only')).toBeNull();
    expect(titleBox().readOnly).toBe(false);
    expect(screen.getByTitle('Share')).toBeInTheDocument();
  });

  it('a manager, or someone the task is assigned to, edits whatever the project says', () => {
    manager = true;
    state = makeStore({ role: 'viewer' });
    const { unmount } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('fields-read-only')).toBeNull();
    unmount();
    manager = false;
    state = makeStore({ role: 'viewer', t: { ...task, assigneeIds: [ME] } });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('fields-read-only')).toBeNull();
  });

  it('keeps every control when the project is not loaded (role unknown)', () => {
    state = makeStore({ projects: [] });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('view-only-note')).toBeNull();
    expect(screen.getByTitle('Share')).toBeInTheDocument();
    expect(screen.getByText('Attach File')).toBeInTheDocument();
  });
});

describe('the "Changes saved" toast', () => {
  it('waits for the save to resolve before saying it saved', async () => {
    state = makeStore({ role: 'editor' });
    let resolve;
    state.updateTask = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.change(titleBox(), { target: { value: 'Fix the big pump' } });
    fireEvent.blur(titleBox());
    expect(state.updateTask).toHaveBeenCalledWith('t1', { title: 'Fix the big pump' });
    await act(async () => { await Promise.resolve(); });
    expect(state.offerUndo).not.toHaveBeenCalled();
    await act(async () => { resolve({}); await Promise.resolve(); });
    expect(state.offerUndo).toHaveBeenCalledWith('Changes saved', expect.any(Function));
  });
});

describe('read-only gaps (review, Oct 21 2026)', () => {
  it('a viewer who is an approver still gets Approve on an extension request', () => {
    state = makeStore({ role: 'viewer', t: { ...task, dueOn: '2026-11-01', dueAgreement: 'extension_requested',
      dueProposal: { dueOn: '2026-11-20', approvers: [ME], by: 'other@x.com', number: 3, baseline: '2026-11-01' } } });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    const approve = screen.getByRole('button', { name: /^Approve/ });
    expect(approve.disabled).toBe(false);
    expect(approve.closest('fieldset[disabled]')).toBeNull();
  });

  it("a viewer cannot remove a collaborator through the chip's x", () => {
    state = makeStore({ role: 'viewer', t: { ...task, followerIds: ['pal@x.com'] } });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('Remove pal@x.com'));
    expect(state.updateTask).not.toHaveBeenCalled();
  });

  it('a viewer cannot add or change subtasks, but can still open one', () => {
    const sub = { ...task, id: 's1', title: 'Order the seal', parentTaskId: 't1', projectId: '', assigneeIds: [] };
    state = makeStore({ role: 'viewer' });
    state.tasks = [task, sub]; state.taskById = { t1: task, s1: sub };
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('subtask-add')).toBeNull();
    const row = document.querySelector('[data-subtask-row="s1"]');
    expect(row.querySelector('button').disabled).toBe(true);     // its complete toggle
    fireEvent.click(row);
    expect(screen.getByLabelText('Task name').value).toBe('Order the seal');
  });

  it('comments: a viewer gets no Reply, a commenter gets Reply but not Pin', async () => {
    const c = { id: 'c1', body: 'Seal is in', authorId: 'boss@x.com', createdAt: '2026-10-20T10:00:00Z' };
    state = makeStore({ role: 'viewer', t: { ...task, commentIds: ['c1'] } });
    state.getComments = vi.fn(() => Promise.resolve([c]));
    const { unmount } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Comments/ })[0]);
    await screen.findAllByText('Seal is in');
    expect(screen.queryByLabelText('Reply')).toBeNull();
    unmount();
    state = makeStore({ role: 'commenter', t: { ...task, commentIds: ['c1'] } });
    state.getComments = vi.fn(() => Promise.resolve([c]));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Comments/ })[0]);
    await waitFor(() => expect(screen.getAllByLabelText('Reply').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Pin')).toBeNull();
  });

  it("an assignee edits the task but cannot remove someone else's file (a project rule)", async () => {
    const files = [
      { id: 'a1', name: 'theirs.pdf', url: 'https://x/theirs.pdf', size: '1 KB', kind: 'other', addedBy: 'boss@x.com' },
      { id: 'a2', name: 'mine.pdf', url: 'https://x/mine.pdf', size: '1 KB', kind: 'other', addedBy: ME },
    ];
    apiOverride.getTaskAttachments = () => Promise.resolve(files);
    state = makeStore({ role: 'viewer', t: { ...task, assigneeIds: [ME] } });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.queryByTestId('fields-read-only')).toBeNull();          // assignee: editor on the task
    expect(await screen.findByLabelText('Remove mine.pdf')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove theirs.pdf')).toBeNull();
    delete apiOverride.getTaskAttachments;
  });
});

describe('approval chip', () => {
  it('reads in Title Case ("Changes Requested", not "changes requested")', () => {
    state = makeStore({ role: 'editor', t: { ...task, approvalStatus: 'changes_requested' } });
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.getByText('Changes Requested')).toBeInTheDocument();
    expect(screen.queryByText('changes requested')).toBeNull();
  });
});
