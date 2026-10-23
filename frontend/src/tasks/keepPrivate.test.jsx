import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Keep Private (Oct 23 2026): a subtask private only because of its main task
// can be kept private on its own, and sharing a private task again asks what
// its subtasks made private with it do - open with it (the default) or stay
// private (keep_subtasks_private, tasks._cascade_level).

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const keepTaskPrivate = vi.fn();
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'keepTaskPrivate' ? keepTaskPrivate : () => Promise.resolve([])) }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }),
}));
let state = {};
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { ShareModal } = await import('./TaskDetailDrawer');
const { shareRules } = await import('./shareRules');

const t = (id, accessLevel = 'org', parentTaskId = '', narrowedBy = '') => ({ id, title: id, accessLevel, parentTaskId, narrowedBy, followerIds: [] });
const applyServerTask = vi.fn();
const notify = vi.fn();
const setTasks = (list) => { state = { tasks: list, taskById: Object.fromEntries(list.map((x) => [x.id, x])), applyServerTask, notify }; };
const open = (task, patch = vi.fn()) => { render(<ShareModal task={task} people={[]} nameOf={(e) => e} patch={patch} onClose={() => {}} />); return patch; };

beforeEach(() => { keepTaskPrivate.mockReset(); applyServerTask.mockReset(); notify.mockReset(); });

describe('shareRules inherited', () => {
  it('only a private subtask marked by its own parent', () => {
    expect(shareRules(t('k', 'restricted', 'p', 'p')).inherited).toBe(true);
    expect(shareRules(t('k', 'restricted', 'p', '')).inherited).toBe(false);     // set by hand
    expect(shareRules(t('k', 'org', 'p', 'p')).inherited).toBe(false);           // stale marker, open
    expect(shareRules(t('k', 'restricted', 'p', 'other')).inherited).toBe(false);
    expect(shareRules(t('top', 'restricted')).inherited).toBe(false);
  });
});

describe('Keep Private on a subtask', () => {
  it('says what it means and keeps it private through the server', async () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p', 'p')];
    setTasks(list);
    const saved = { ...list[1], narrowedBy: '' };
    keepTaskPrivate.mockResolvedValue(saved);
    const patch = open(list[1]);
    const box = screen.getByTestId('share-inherited');
    expect(box.textContent).toMatch(/Private Because of Its Main Task/);
    expect(box.textContent).toMatch(/only the people on this subtask will see it; people who can see the main task won't/);
    fireEvent.click(screen.getByRole('button', { name: /Keep Private/ }));
    await waitFor(() => expect(applyServerTask).toHaveBeenCalledWith(saved));
    expect(keepTaskPrivate).toHaveBeenCalledWith('k');
    expect(notify).toHaveBeenCalledWith('Kept private');
    expect(patch).not.toHaveBeenCalled();
  });

  it('a refusal is said in the popup', async () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p', 'p')];
    setTasks(list);
    keepTaskPrivate.mockRejectedValue(Object.assign(new Error('Task not found'), { status: 404 }));
    open(list[1]);
    fireEvent.click(screen.getByRole('button', { name: /Keep Private/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Task not found');
    expect(applyServerTask).not.toHaveBeenCalled();
  });

  it('is not offered on a subtask private by hand or an open one', () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p'), t('o', 'org', 'p2')];
    setTasks(list);
    open(list[1]);
    expect(screen.queryByTestId('share-inherited')).toBeNull();
  });
});

describe('Sharing a private task again', () => {
  const tree = () => [t('top', 'restricted'), t('a', 'restricted', 'top', 'top'), t('b', 'restricted', 'top', 'top')];

  it('asks first, and Open Subtasks Too is the plain reopen', () => {
    const list = tree();
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    expect(patch).not.toHaveBeenCalled();
    const choice = screen.getByTestId('share-reopen-choice');
    expect(choice.textContent).toMatch(/Its 2 subtasks made private with it:/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Subtasks Too' }));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'org' });
    expect(screen.queryByTestId('share-reopen-choice')).toBeNull();
  });

  it('Keep Them Private sends the flag', () => {
    const list = tree();
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Them Private' }));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'org', keepSubtasksPrivate: true });
  });

  it('Cancel changes nothing, and no subtasks to bring back means no question', () => {
    const list = tree();
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(patch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('share-reopen-choice')).toBeNull();
  });

  it('a private task with nothing made private with it opens at once', () => {
    const list = [t('solo', 'restricted'), t('hand', 'restricted', 'solo')];
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'org' });
  });
});
