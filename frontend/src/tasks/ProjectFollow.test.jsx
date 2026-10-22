import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Follow a project (Oct 22 2026): the header's Follow / Following button,
// the follower count and list, and Add Follower only for owners and editors
// (the server's rule - require_project_access(..., "editor")).

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const apiOverride = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => apiOverride[k] || (() => Promise.resolve([])) }) }));
let manager = false;
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => manager, myLevel: 1, myEmail: '' }),
}));

const ME = 'me@x.com';
const project = (over = {}) => ({
  id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted',
  memberIds: [ME, 'ann@x.com'], memberRoles: {}, followerIds: [], archived: false, ...over,
});

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
function makeStore(p) {
  return {
    myEmail: ME, nameOf: (e) => ({ 'ann@x.com': 'Ann Lee', 'boss@x.com': 'Boss Man', [ME]: 'Me Myself' }[e] || e),
    projects: [p],
    followProject: vi.fn(() => Promise.resolve({})),
    unfollowProject: vi.fn(() => Promise.resolve({})),
    addProjectFollower: vi.fn(() => Promise.resolve({})),
    removeProjectFollower: vi.fn(() => Promise.resolve({})),
    offerUndo: vi.fn(),
  };
}

const { default: ProjectFollowControl } = await import('./ProjectFollow');
const { canManageFollowers, isFollowing, projectFollowers } = await import('./followRules');

beforeEach(() => {
  manager = false;
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('follow helpers', () => {
  it('reads followers case-insensitively', () => {
    const p = project({ followerIds: ['Me@X.com', '', null] });
    expect(projectFollowers(p)).toEqual([ME]);
    expect(isFollowing(p, ME)).toBe(true);
    expect(isFollowing(project(), ME)).toBe(false);
    expect(isFollowing(p, '')).toBe(false);
  });

  it('lets owners, editors and managers manage followers, not viewers', () => {
    expect(canManageFollowers(project({ ownerId: ME }), ME)).toBe(true);
    expect(canManageFollowers(project(), ME)).toBe(true);                              // bare member = editor
    expect(canManageFollowers(project({ memberRoles: { [ME]: 'viewer' } }), ME)).toBe(false);
    expect(canManageFollowers(project({ memberRoles: { [ME]: 'commenter' } }), ME)).toBe(false);
    expect(canManageFollowers(project({ memberRoles: { [ME]: 'viewer' } }), ME, true)).toBe(true);
  });

  it("reads the email's project link", async () => {
    const { projectIdFromUrl } = await import('./lib');
    window.history.pushState({}, '', '/tasks/projects?project=p9');
    expect(projectIdFromUrl()).toBe('p9');
    window.history.pushState({}, '', '/tasks/projects');
    expect(projectIdFromUrl()).toBe('');
  });

  it('taskRoleFor reads team roles through the shared helper, unchanged', async () => {
    const { taskRoleFor, projectRoleWithTeams } = await import('./lib');
    const p = project({ memberIds: [], memberRoles: {} });
    const teams = [{ id: 't1', projectIds: ['p1'], memberIds: [ME], accessRole: 'commenter' }];
    const t = { id: 'x', projectId: 'p1', assigneeIds: [] };
    expect(projectRoleWithTeams(p, ME, teams)).toBe('commenter');
    expect(taskRoleFor(t, { projects: [p], teams, email: ME })).toBe('commenter');
    expect(taskRoleFor({ ...t, assigneeIds: [ME] }, { projects: [p], teams, email: ME })).toBe('editor');
    expect(taskRoleFor(t, { projects: [p], teams: [], email: ME })).toBe(null);
  });

  it('counts an editor role held through an approved team, not an unapproved one', () => {
    const p = project({ memberIds: [], memberRoles: {} });           // restricted, no direct grant
    const team = (over = {}) => ({ id: 't1', projectIds: ['p1'], memberIds: [ME], accessRole: 'editor', ...over });
    expect(canManageFollowers(p, ME, false, [])).toBe(false);
    expect(canManageFollowers(p, ME, false, [team()])).toBe(true);
    expect(canManageFollowers(p, ME, false, [team({ accessRole: 'viewer' })])).toBe(false);
    expect(canManageFollowers(p, ME, false, [team({ approvalStatus: 'pending' })])).toBe(false);
    // A team can only raise a direct grant, never lower it.
    expect(canManageFollowers(project({ memberRoles: { [ME]: 'editor' } }), ME, false, [team({ accessRole: 'viewer' })])).toBe(true);
  });
});

describe('ProjectFollowControl', () => {
  it('shows Follow and follows on click', async () => {
    const p = project();
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    const b = screen.getByTestId('project-follow');
    expect(b).toHaveTextContent('Follow');
    expect(b).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(b);
    await waitFor(() => expect(state.followProject).toHaveBeenCalledWith('p1'));
    expect(state.offerUndo).toHaveBeenCalled();
    expect(screen.getByTestId('project-followers')).toHaveTextContent('0');
  });

  it('shows Following with the count and unfollows on click', async () => {
    const p = project({ followerIds: [ME, 'ann@x.com'] });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    const b = screen.getByTestId('project-follow');
    expect(b).toHaveTextContent('Following');
    expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('project-followers')).toHaveTextContent('2');
    fireEvent.click(b);
    await waitFor(() => expect(state.unfollowProject).toHaveBeenCalledWith('p1'));
  });

  it('compact (phone) keeps the button but drops its words', () => {
    const p = project({ followerIds: [ME] });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} compact />);
    expect(screen.getByTestId('project-follow')).not.toHaveTextContent('Following');
    expect(screen.getByTestId('project-follow')).toHaveAttribute('aria-label', 'Following');
  });

  it('on a phone the followers open as a full-screen sheet', async () => {
    globalThis.matchMedia = (q) => ({
      matches: true, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
    const p = project({ followerIds: ['ann@x.com'] });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} compact />);
    fireEvent.click(screen.getByTestId('project-followers'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('nx-modal-sheet');
    expect(within(dialog).getByText('Ann Lee')).toBeInTheDocument();
  });

  it('an archived project offers no Follow button but still shows who follows', () => {
    const p = project({ archived: true, followerIds: ['ann@x.com'] });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    expect(screen.queryByTestId('project-follow')).toBeNull();
    expect(screen.getByTestId('project-followers')).toHaveTextContent('1');
  });

  it('lists followers by name, and an editor can add and remove', async () => {
    const p = project({ followerIds: ['ann@x.com', ME] });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    fireEvent.click(screen.getByTestId('project-followers'));
    const list = await screen.findByTestId('followers-list');
    expect(within(list).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(list).getByText('(You)')).toBeInTheDocument();
    expect(screen.getByText('2 Followers')).toBeInTheDocument();
    expect(screen.getByText('Add Follower', { selector: 'div' })).toBeInTheDocument();
    fireEvent.click(within(list).getByLabelText('Remove Ann Lee'));
    await waitFor(() => expect(state.removeProjectFollower).toHaveBeenCalledWith('p1', 'ann@x.com'));
    fireEvent.click(within(list).getByLabelText('Stop Following'));
    await waitFor(() => expect(state.unfollowProject).toHaveBeenCalledWith('p1'));
  });

  it('a viewer sees the list but no Add Follower and can only remove themselves', async () => {
    const p = project({ followerIds: ['ann@x.com', ME], memberRoles: { [ME]: 'viewer' } });
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    fireEvent.click(screen.getByTestId('project-followers'));
    const list = await screen.findByTestId('followers-list');
    expect(within(list).getByText('Ann Lee')).toBeInTheDocument();
    expect(screen.queryByText('Add Follower', { selector: 'div' })).toBeNull();
    expect(within(list).queryByLabelText('Remove Ann Lee')).toBeNull();
    expect(within(list).getByLabelText('Stop Following')).toBeInTheDocument();
  });

  it('an editor through a team gets Add Follower', async () => {
    const p = project({ followerIds: ['ann@x.com'], memberIds: [], memberRoles: {} });
    state = makeStore(p);
    state.teams = [{ id: 't1', projectIds: ['p1'], memberIds: [ME], accessRole: 'editor' }];
    render(<ProjectFollowControl project={p} />);
    fireEvent.click(screen.getByTestId('project-followers'));
    await screen.findByTestId('followers-list');
    expect(screen.getByText('Add Follower', { selector: 'div' })).toBeInTheDocument();
  });

  it('says so when nobody follows yet', async () => {
    const p = project();
    state = makeStore(p);
    render(<ProjectFollowControl project={p} />);
    fireEvent.click(screen.getByTestId('project-followers'));
    expect(await screen.findByText('Nobody follows this project yet.')).toBeInTheDocument();
  });

  it('a failed follow opens the list with the reason', async () => {
    const p = project();
    state = makeStore(p);
    state.followProject = vi.fn(() => Promise.reject(new Error('Project not found')));
    render(<ProjectFollowControl project={p} />);
    fireEvent.click(screen.getByTestId('project-follow'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Project not found');
  });
});
