import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The task drawer's Scheduling select and the Lag box beside each predecessor
// (Neil, 11/08/2026): Manual / Automatic, Automatic disabled with nothing to
// follow, a lag typed saves as dependencyLags, and switching to Automatic asks
// first when the server's preview says tasks will move.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const apiOverride = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => apiOverride[k] || (() => Promise.resolve([])) }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => true }),
}));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: () => Promise.resolve(), prompt: () => Promise.resolve(null), undo: () => {} } }));

const ME = 'me@x.com';
const project = { id: 'p1', name: 'Gate', ownerId: ME, accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: 'owner' } };
const demo = { id: 'a', title: 'Demo', status: 'in_progress', priority: 'medium', projectId: 'p1', dueOn: '2026-11-12', blockingIds: ['b'], assigneeIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {} };
const footings = { id: 'b', title: 'Footings', status: 'not_started', priority: 'medium', projectId: 'p1', parentTaskId: '', startOn: '2026-11-16', dueOn: '2026-11-18',
  blockedByIds: ['a'], dependencyTypes: { a: 'FS' }, dependencyLags: {}, scheduleMode: 'manual',
  assigneeIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false, description: '' };
const loner = { ...footings, id: 'c', title: 'Paint', blockedByIds: [], dependencyTypes: {} };

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
function makeStore(tasks) {
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), teams: [], projects: [project], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' }, in_progress: { label: 'In Progress', color: '#888', tint: '#eee' } },
    statusOrder: ['not_started', 'in_progress'], statusOrderFor: () => ['not_started', 'in_progress'], loading: false, runningTimer: null,
    projectName: () => 'Gate', teamName: () => '', nameOf: (e) => e, myEmail: ME,
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
    getComments: vi.fn(() => Promise.resolve([])), addComment: vi.fn(), offerUndo: vi.fn(),
    toggleComplete: vi.fn(() => Promise.resolve()), refresh: vi.fn(), applyServerTask: vi.fn(),
    startTimer: vi.fn(), stopTimer: vi.fn(),
  };
}

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

beforeEach(() => {
  confirm.mockReset();
  delete apiOverride.previewTaskSchedule;
});

describe('Scheduling in the drawer', () => {
  it('shows the select with Automatic enabled when the task has a predecessor, and a lag box per predecessor', () => {
    state = makeStore([demo, footings]);
    render(<TaskDetailDrawer taskId="b" onClose={() => {}} />);
    const sel = screen.getByLabelText('Scheduling');
    expect(sel.value).toBe('manual');
    expect(within(screen.getByLabelText('Scheduling')).getByRole('option', { name: /Automatic/ }).disabled).toBe(false);
    const lag = screen.getByLabelText('Lag after Demo');
    expect(lag.value).toBe('0');
    fireEvent.change(lag, { target: { value: '2' } });
    fireEvent.blur(lag);
    expect(state.updateTask).toHaveBeenCalledWith('b', { dependencyLags: { a: 2 } });
  });

  it('Automatic is disabled with nothing to follow', () => {
    state = makeStore([loner]);
    render(<TaskDetailDrawer taskId="c" onClose={() => {}} />);
    expect(within(screen.getByLabelText('Scheduling')).getByRole('option', { name: /Automatic/ }).disabled).toBe(true);
    expect(screen.queryByLabelText(/^Lag after/)).toBeNull();
  });

  it('switching to Automatic asks when the preview says tasks move, and saves on yes', async () => {
    state = makeStore([demo, footings]);
    apiOverride.previewTaskSchedule = vi.fn(() => Promise.resolve({ moved: [{ id: 'b', title: 'Footings', from: {}, to: {} }] }));
    confirm.mockResolvedValue(true);
    render(<TaskDetailDrawer taskId="b" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Scheduling'), { target: { value: 'auto' } });
    await waitFor(() => expect(apiOverride.previewTaskSchedule).toHaveBeenCalledWith('b', { schedule_mode: 'auto' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatch(/1 task may move/);
    await waitFor(() => expect(state.updateTask).toHaveBeenCalledWith('b', { scheduleMode: 'auto' }));
  });

  it('a no keeps the task manual; nothing to move needs no question', async () => {
    state = makeStore([demo, footings]);
    apiOverride.previewTaskSchedule = vi.fn(() => Promise.resolve({ moved: [{ id: 'b' }] }));
    confirm.mockResolvedValue(false);
    const { unmount } = render(<TaskDetailDrawer taskId="b" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Scheduling'), { target: { value: 'auto' } });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(state.updateTask).not.toHaveBeenCalled();
    unmount();

    state = makeStore([demo, footings]);
    apiOverride.previewTaskSchedule = vi.fn(() => Promise.resolve({ moved: [] }));
    confirm.mockReset();
    render(<TaskDetailDrawer taskId="b" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Scheduling'), { target: { value: 'auto' } });
    await waitFor(() => expect(state.updateTask).toHaveBeenCalledWith('b', { scheduleMode: 'auto' }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
