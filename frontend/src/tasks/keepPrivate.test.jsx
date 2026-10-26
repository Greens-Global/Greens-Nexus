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
const { shareRules, mayOpenUp } = await import('./shareRules');

const t = (id, accessLevel = 'org', parentTaskId = '', narrowedBy = '') => ({ id, title: id, accessLevel, parentTaskId, narrowedBy, followerIds: [] });
const applyServerTask = vi.fn();
const notify = vi.fn();
const setTasks = (list) => { state = { tasks: list, taskById: Object.fromEntries(list.map((x) => [x.id, x])), applyServerTask, notify }; };
const open = (task, patch = vi.fn(), canKeepPrivate = true) => { render(<ShareModal task={task} people={[]} nameOf={(e) => e} patch={patch} onClose={() => {}} canKeepPrivate={canKeepPrivate} />); return patch; };

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

describe('mayOpenUp (the server\'s _may_open_up)', () => {
  const me = 'me@greensglobal.com';
  const proj = (role) => ({ id: 'pr', accessLevel: 'restricted', ownerId: 'boss@greensglobal.com', memberIds: role ? [me] : [], memberRoles: role ? { [me]: role } : {} });
  const top = { id: 'p', projectId: 'pr', parentTaskId: '' };
  const kid = (extra = {}) => ({ id: 'k', projectId: '', parentTaskId: 'p', ownerId: 'o@greensglobal.com', createdBy: 'c@greensglobal.com', assigneeIds: [], ...extra });
  const opts = (role, extra = {}) => ({ projects: [proj(role)], taskById: { p: top }, email: me, ...extra });

  it('owner, creator, project editor and manager may; an assignee or viewer may not', () => {
    expect(mayOpenUp(kid({ ownerId: me }), opts(null))).toBe(true);
    expect(mayOpenUp(kid({ createdBy: me }), opts(null))).toBe(true);
    expect(mayOpenUp(kid(), opts('editor'))).toBe(true);
    expect(mayOpenUp(kid(), opts(null, { isManager: true }))).toBe(true);
    expect(mayOpenUp(kid({ assigneeIds: [me], assigneeId: me }), opts(null))).toBe(false);
    expect(mayOpenUp(kid(), opts('viewer'))).toBe(false);
  });

  it('no project means owner, creator or manager only; a guest never', () => {
    const solo = { id: 'k', projectId: '', parentTaskId: 'q', ownerId: 'o@greensglobal.com', createdBy: '' };
    expect(mayOpenUp(solo, { taskById: { q: { id: 'q', projectId: '', parentTaskId: '' } }, email: me })).toBe(false);
    expect(mayOpenUp(kid({ ownerId: me }), opts('editor', { isExternal: true }))).toBe(false);
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

  it('is not offered to someone below the open-up bar', () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p', 'p')];
    setTasks(list);
    open(list[1], vi.fn(), false);
    expect(screen.queryByTestId('share-inherited')).toBeNull();
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
    expect(choice.textContent).toMatch(/2 subtasks were made private with it:/);
    // Enter must never widen by accident: focus starts on Cancel.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Subtasks Too' }));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'org' });
    expect(screen.queryByTestId('share-reopen-choice')).toBeNull();
  });

  it('one subtask reads in the singular, and focus goes back to Everyone after a choice', async () => {
    const list = [t('top', 'restricted'), t('a', 'restricted', 'top', 'top')];
    setTasks(list);
    open(list[0]);
    const everyone = screen.getByText('Everyone in your organization').closest('button');
    fireEvent.click(everyone);
    expect(screen.getByTestId('share-reopen-choice').textContent).toMatch(/1 subtask was made private with it:/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep Them Private' }));
    await waitFor(() => expect(document.activeElement).toBe(everyone));
  });

  it('Keep Them Private sends the flag', () => {
    const list = tree();
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Them Private' }));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'org', keepSubtasksPrivate: true });
  });

  it('Cancel changes nothing, and no subtasks to bring back means no question', async () => {
    const list = tree();
    setTasks(list);
    const patch = open(list[0]);
    fireEvent.click(screen.getByText('Everyone in your organization').closest('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(patch).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Everyone in your organization').closest('button')));
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
