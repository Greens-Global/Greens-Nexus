import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Share on a subtask / a task with subtasks (Oct 22 2026): a subtask is never
// wider than its parent, so under a private task "Everyone" is shown but
// cannot be picked, with the reason; making a task private warns how many of
// its open subtasks go private with it (the server takes them along).

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }),
}));
let state = { tasks: [], taskById: {} };
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

const { ShareModal } = await import('./TaskDetailDrawer');
const { shareRules } = await import('./shareRules');

const t = (id, accessLevel = 'org', parentTaskId = '', narrowedBy = '') => ({ id, title: id, accessLevel, parentTaskId, narrowedBy, followerIds: [] });
const setTasks = (list) => { state = { tasks: list, taskById: Object.fromEntries(list.map((x) => [x.id, x])) }; };

describe('shareRules', () => {
  it('counts the open subtasks below, at any depth', () => {
    const list = [t('top'), t('a', 'org', 'top'), t('b', 'restricted', 'top'), t('c', 'org', 'b')];
    expect(shareRules(list[0], list, {})).toMatchObject({ underPrivate: false, openBelow: 2, reopenBelow: 0 });
  });

  it('a subtask under a private parent, or one this person cannot see, is under a private task', () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p'), t('o', 'org'), t('k2', 'restricted', 'o')];
    expect(shareRules(list[1], list, {}).underPrivate).toBe(true);
    expect(shareRules(list[3], list, {}).underPrivate).toBe(false);
    expect(shareRules(t('lost', 'restricted', 'unseen'), list, {}).underPrivate).toBe(true);
  });
});

describe('ShareModal', () => {
  it('shows Everyone disabled with the reason on a subtask under a private task', () => {
    const list = [t('p', 'restricted'), t('k', 'restricted', 'p')];
    setTasks(list);
    const patch = vi.fn();
    render(<ShareModal task={list[1]} people={[]} nameOf={(e) => e} patch={patch} onClose={() => {}} />);
    const everyone = screen.getByText('Everyone in your organization').closest('button');
    expect(everyone).toBeDisabled();
    expect(screen.getByTestId('share-org-locked').textContent).toMatch(/while the task it is under is private/);
    fireEvent.click(everyone);
    expect(patch).not.toHaveBeenCalled();
  });

  it('warns that open subtasks become private too', () => {
    const list = [t('top'), t('a', 'org', 'top'), t('b', 'org', 'top')];
    setTasks(list);
    const patch = vi.fn();
    render(<ShareModal task={list[0]} people={[]} nameOf={(e) => e} patch={patch} onClose={() => {}} />);
    expect(screen.getByTestId('share-subtasks-warning').textContent).toBe('Its 2 subtasks that everyone can see become private too.');
    fireEvent.click(screen.getByText('Members of this task and connected projects').closest('button'));
    expect(patch).toHaveBeenCalledWith({ accessLevel: 'restricted' });
  });

  it('no warning and Everyone open on an ordinary task', () => {
    const list = [t('solo')];
    setTasks(list);
    render(<ShareModal task={list[0]} people={[]} nameOf={(e) => e} patch={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('share-subtasks-warning')).toBeNull();
    expect(screen.getByText('Everyone in your organization').closest('button')).not.toBeDisabled();
  });

  it('opening up says how many subtasks made private with it come back', () => {
    // a, b private because of top; c because of a; d private by hand; e under d.
    const list = [t('top', 'restricted'), t('a', 'restricted', 'top', 'top'), t('b', 'restricted', 'top', 'top'),
      t('c', 'restricted', 'a', 'a'), t('d', 'restricted', 'top'), t('e', 'restricted', 'd', 'd')];
    setTasks(list);
    expect(shareRules(list[0], list, {}).reopenBelow).toBe(3);
    render(<ShareModal task={list[0]} people={[]} nameOf={(e) => e} patch={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('share-subtasks-reopen').textContent).toBe('Its 3 subtasks made private with it open to everyone again.');
  });
});

describe('Duplicate keeps a subtask private the way it was', () => {
  it('sends a hand-set private level, and leaves an inherited one to the server', async () => {
    const { duplicateTaskData } = await import('./lib');
    const base = { id: 'k', title: 'K', parentTaskId: 'p', accessLevel: 'restricted' };
    expect(duplicateTaskData({ ...base, narrowedBy: '' }).accessLevel).toBe('restricted');
    expect(duplicateTaskData({ ...base, narrowedBy: 'p' }).accessLevel).toBeUndefined();
  });
});
