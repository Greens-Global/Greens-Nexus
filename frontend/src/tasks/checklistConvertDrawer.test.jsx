import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Convert to Subtask in the task drawer (Neil, Oct 22 2026): offered on a
// checklist line to the people who may add a subtask (an editor of the
// project - being assigned the task is not enough), never on an HR checklist
// task; read-only roles see the lines without edit controls. Converting puts
// the new subtask in the drawer's Subtasks list and offers Open.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const api = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (() => Promise.resolve([])) }) }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: () => Promise.resolve(true), alert: () => Promise.resolve() } }));

const ME = 'me@x.com';
const base = {
  id: 't1', title: 'Fix the pump', status: 'not_started', priority: 'medium', projectId: 'p1', parentTaskId: '',
  subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false,
  checklistTotal: 1, checklistDone: 0, assigneeIds: [ME],
};
const project = (role) => [{ id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: role } }];
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

function setup(task, role) {
  state = {
    tasks: [task], taskById: { [task.id]: task }, teams: [], projects: project(role), customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false, projectName: () => 'Plant', teamName: () => '', nameOf: (e) => e, myEmail: ME,
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(), getComments: vi.fn(() => Promise.resolve([])),
    addComment: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(), refresh: vi.fn(), applyServerTask: vi.fn(),
    convertChecklistItem: vi.fn(),
  };
}

beforeEach(() => {
  for (const k of Object.keys(api)) delete api[k];
  api.getTaskChecklist = vi.fn(() => Promise.resolve([{ id: 'i1', taskId: 't1', title: 'Call the vendor', done: false }]));
  globalThis.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

describe('Convert to Subtask in the drawer', () => {
  it('a project editor converts a line; Open steps into the new subtask', async () => {
    setup(base, 'editor');
    const sub = { ...base, id: 's1', title: 'Call the vendor', parentTaskId: 't1', checklistTotal: 0 };
    state.convertChecklistItem = vi.fn(async () => {
      state = { ...state, tasks: [...state.tasks, sub], taskById: { ...state.taskById, s1: sub } };
      return { subtask: sub, task: { ...base, checklistTotal: 0, subtaskIds: ['s1'] } };
    });
    const { rerender } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('Actions for Call the vendor'));
    const item = await screen.findByRole('menuitem', { name: /Convert to Subtask/ });
    await act(async () => { fireEvent.click(item); });
    expect(state.convertChecklistItem).toHaveBeenCalledWith('i1');
    const [label, open, action] = state.offerUndo.mock.calls[0];
    expect([label, action]).toEqual(['Converted to a subtask', 'Open']);
    rerender(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await act(async () => { open(); });
    // The drawer now shows the subtask itself.
    expect((await screen.findAllByDisplayValue('Call the vendor')).length).toBeGreaterThan(0);
  });

  it('an assignee who is only a commenter on the project is not offered it', async () => {
    setup(base, 'commenter');
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await screen.findByText('Call the vendor');
    expect(screen.queryByLabelText('Actions for Call the vendor')).toBeNull();
  });

  it('never on an HR checklist task', async () => {
    setup({ ...base, hrChecklist: true }, 'editor');
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await screen.findByText('Call the vendor');
    expect(screen.queryByLabelText('Actions for Call the vendor')).toBeNull();
  });

  it('a viewer sees the lines without edit controls', async () => {
    setup({ ...base, assigneeIds: ['other@x.com'] }, 'viewer');
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await screen.findByText('Call the vendor');
    expect(screen.queryByLabelText('Add checklist item')).toBeNull();
    expect(screen.queryByLabelText('Remove item')).toBeNull();
    expect(screen.queryByLabelText('Actions for Call the vendor')).toBeNull();
  });
});
