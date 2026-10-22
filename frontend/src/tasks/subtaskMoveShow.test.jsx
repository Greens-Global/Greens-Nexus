import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { descendantIds, moveTargets, withSubtasks, nestSubtaskRows, EMPTY_FILTER } from './lib';

// Move To... and Show Subtasks (Neil, Oct 22 2026).
//  - The Move To picker offers only tasks this person can edit, never the
//    task itself or anything under it, and Make Top-Level Task only for a
//    subtask; Move sends the new parent through the store's moveTask.
//  - Board: with Show Subtasks on, each subtask is a card in its own status
//    column saying whose subtask it is (the name opens the parent); a
//    read-only person's cards do not drag.
//  - Timeline: subtasks sit right under their parent, indented, with a
//    chevron to fold them; a subtask whose parent is not on the timeline
//    says "in <parent>"; read-only bars do not drag; the phone layout holds.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const rescheduleTask = vi.fn(() => Promise.resolve({ task: null, moved: [], skipped: [] }));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'rescheduleTask' ? (...a) => rescheduleTask(...a) : () => Promise.resolve([])) }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }),
}));
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state, statusesForProject: () => [] }));

const ME = 'me@x.com';
const base = { status: 'not_started', priority: 'medium', projectId: 'p1', assigneeIds: [], followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], customFieldValues: {}, completed: false };
const T = (id, extra = {}) => ({ ...base, id, title: id.toUpperCase(), parentTaskId: '', ...extra });
const project = (id, role) => ({ id, name: id === 'p1' ? 'Plant' : 'Office', ownerId: 'boss@x.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: role } });

function makeStore(tasks, { roles = { p1: 'editor', p2: 'editor' } } = {}) {
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), teams: [],
    projects: Object.entries(roles).map(([id, r]) => project(id, r)), sections: [], customFields: [], customStatuses: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' }, in_progress: { label: 'In Progress', color: '#48f', tint: '#eef' } },
    statusOrder: ['not_started', 'in_progress'], myEmail: ME, nameOf: (e) => e,
    projectName: (id) => ({ p1: 'Plant', p2: 'Office' }[id] || ''),
    moveTask: vi.fn(() => Promise.resolve({})), updateTask: vi.fn(() => Promise.resolve({})), setStatus: vi.fn(),
    toggleComplete: vi.fn(), addComment: vi.fn(), createTask: vi.fn(), applyServerTask: vi.fn(),
    createSection: vi.fn(), updateSection: vi.fn(), deleteSection: vi.fn(),
  };
}

function phone(on) {
  globalThis.matchMedia = (q) => ({
    matches: on && q.includes('max-width: 640px'), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

beforeEach(() => { phone(false); rescheduleTask.mockClear(); });
// jsdom has no PointerEvent; a MouseEvent named "pointerdown" reaches React's
// onPointerDown with real coordinates (as in timelineDrag.test.jsx).
const pointer = (el, type, clientX) => fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));

// ── lib ─────────────────────────────────────────────────────────────────────
describe('move targets', () => {
  const tasks = [
    T('top'), T('mid', { parentTaskId: 'top' }), T('leaf', { parentTaskId: 'mid' }),
    T('other'), T('far', { projectId: 'p2' }), T('sec', { type: 'section' }), T('locked'),
  ];
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

  it('finds every task under one, however deep', () => {
    expect([...descendantIds('top', tasks)].sort()).toEqual(['leaf', 'mid']);
    expect(descendantIds('leaf', tasks).size).toBe(0);
  });

  it('excludes the task, its descendants, its parent, sections and tasks you cannot edit', () => {
    const ids = moveTargets(byId.top, tasks, { canEdit: (t) => t.id !== 'locked', taskById: byId }).map((t) => t.id);
    expect(ids).not.toContain('top');
    expect(ids).not.toContain('mid');
    expect(ids).not.toContain('leaf');
    expect(ids).not.toContain('sec');
    expect(ids).not.toContain('locked');
    const forMid = moveTargets(byId.mid, tasks, { taskById: byId }).map((t) => t.id);
    expect(forMid).not.toContain('top');      // already its parent
    expect(forMid).not.toContain('leaf');
  });

  it("lists the task's own project first", () => {
    const ids = moveTargets(byId.leaf, tasks, { taskById: byId }).map((t) => t.id);
    expect(ids[ids.length - 1]).toBe('far');
  });
});

describe('show subtasks rows', () => {
  it('adds the subtasks that pass the filter, even when the parent does not', () => {
    const tasks = [T('a', { priority: 'low' }), T('kid', { parentTaskId: 'a', priority: 'high' }), T('kid2', { parentTaskId: 'a', priority: 'low' })];
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const f = { ...EMPTY_FILTER, priorities: ['high'] };
    expect(withSubtasks([], tasks, f, byId).map((t) => t.id)).toEqual(['kid']);
    expect(withSubtasks([tasks[0]], tasks, EMPTY_FILTER, byId).map((t) => t.id)).toEqual(['a', 'kid', 'kid2']);
  });

  it('nests subtasks right under their parent in its own order', () => {
    const tasks = [
      T('a'), T('b'),
      T('late', { parentTaskId: 'a', dueOn: '2026-11-05' }), T('soon', { parentTaskId: 'a', dueOn: '2026-11-01' }),
      T('deep', { parentTaskId: 'soon' }),
    ];
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const rows = nestSubtaskRows([byId.a, byId.b, byId.late, byId.soon, byId.deep], tasks, { taskById: byId });
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([['a', 0], ['soon', 1], ['deep', 2], ['late', 1], ['b', 0]]);
    expect(rows[0].kids).toBe(2);
    // Manual order on the parent wins over due dates.
    byId.a = { ...byId.a, subtaskOrder: 'manual' };
    const manual = nestSubtaskRows([byId.a, byId.late, byId.soon],
      [byId.a, { ...byId.late, position: 1 }, { ...byId.soon, position: 2 }], { taskById: byId });
    expect(manual.map((r) => r.task.id)).toEqual(['a', 'late', 'soon']);
  });

  it('hides a folded subtree and keeps an orphan with its breadcrumb', () => {
    const tasks = [T('a'), T('kid', { parentTaskId: 'a' }), T('grand', { parentTaskId: 'kid' }), T('lost', { parentTaskId: 'gone' }), T('gone')];
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const folded = nestSubtaskRows([byId.a, byId.kid, byId.grand], tasks.slice(0, 3), { collapsed: new Set(['a']), taskById: byId });
    expect(folded.map((r) => r.task.id)).toEqual(['a']);
    const orphan = nestSubtaskRows([byId.lost], [byId.lost], { taskById: byId });
    expect(orphan).toEqual([{ task: byId.lost, depth: 0, crumb: 'GONE', kids: 0 }]);
  });
});

// ── Move To picker ──────────────────────────────────────────────────────────
describe('MoveTaskModal', () => {
  const tasks = [
    T('top'), T('mid', { parentTaskId: 'top' }), T('leaf', { parentTaskId: 'mid' }),
    T('other'), T('viewonly', { projectId: 'p2' }),
  ];

  it('offers only editable tasks outside the subtree, and moves on Move', async () => {
    state = makeStore(tasks, { roles: { p1: 'editor', p2: 'viewer' } });
    const { default: MoveTaskModal } = await import('./MoveTaskModal');
    const onClose = vi.fn();
    render(<MoveTaskModal taskId="mid" onClose={onClose} />);
    const list = screen.getByTestId('move-targets');
    expect(within(list).queryByText('LEAF')).toBeNull();
    expect(within(list).queryByText('MID')).toBeNull();
    expect(within(list).queryByText('TOP')).toBeNull();          // its current parent
    expect(within(list).queryByText('VIEWONLY')).toBeNull();     // a viewer cannot add to it
    expect(screen.getByText('Make Top-Level Task')).toBeTruthy();
    fireEvent.click(within(list).getByText('OTHER'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move' })); });
    expect(state.moveTask).toHaveBeenCalledWith('mid', { parentTaskId: 'other' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a top-level task has no Make Top-Level option; search narrows the list', async () => {
    state = makeStore(tasks);
    const { default: MoveTaskModal } = await import('./MoveTaskModal');
    render(<MoveTaskModal taskId="other" onClose={() => {}} />);
    expect(screen.queryByText('Make Top-Level Task')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'lea' } });
    const list = screen.getByTestId('move-targets');
    expect(within(list).getByText('LEAF')).toBeTruthy();
    expect(within(list).queryByText('TOP')).toBeNull();
  });

  it('making a subtask top-level sends an empty parent', async () => {
    state = makeStore(tasks);
    const { default: MoveTaskModal } = await import('./MoveTaskModal');
    render(<MoveTaskModal taskId="leaf" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Make Top-Level Task'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Move' })); });
    expect(state.moveTask.mock.calls[0][0]).toBe('leaf');
    expect(state.moveTask.mock.calls[0][1].parentTaskId).toBe('');
  });
});

// ── Board ───────────────────────────────────────────────────────────────────
describe('Board with Show Subtasks', () => {
  const parent = T('parent', { title: 'Pour slab' });
  const kid = T('kid', { title: 'Order rebar', parentTaskId: 'parent', status: 'in_progress' });
  const ctx = { nameOf: (e) => e, projectName: () => 'Plant', teamName: () => '' };

  it('has the switch off by default and draws subtask cards when it is on', async () => {
    state = makeStore([parent, kid]);
    const { default: BoardView } = await import('./views/board');
    const toggle = vi.fn();
    const { rerender } = render(<BoardView visible={[parent]} ctx={ctx} store={state} onOpen={() => {}} lockedProjectId="p1" onToggleSubtasks={toggle} />);
    const sw = screen.getByRole('button', { name: /Show Subtasks/ });
    expect(sw.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Order rebar')).toBeNull();
    fireEvent.click(sw);
    expect(toggle).toHaveBeenCalled();
    const onOpen = vi.fn();
    rerender(<BoardView visible={[parent, kid]} ctx={ctx} store={state} onOpen={onOpen} lockedProjectId="p1" showSubtasks onToggleSubtasks={toggle} />);
    expect(screen.getByRole('button', { name: /Show Subtasks/ }).getAttribute('aria-pressed')).toBe('true');
    const card = document.querySelector('[data-subtask-card="kid"]');
    expect(card).toBeTruthy();
    expect(within(card).getByTestId('subtask-of').textContent).toContain('Pour slab');
    fireEvent.click(within(card).getByRole('button', { name: 'Pour slab' }));
    expect(onOpen).toHaveBeenCalledWith('parent');
    // In its own status column: In Progress counts it, Not Started does not.
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  });

  it('a read-only person sees the cards but cannot drag them', async () => {
    state = makeStore([parent, kid], { roles: { p1: 'viewer' } });
    const { default: BoardView } = await import('./views/board');
    render(<BoardView visible={[parent, kid]} ctx={ctx} store={state} onOpen={() => {}} lockedProjectId="p1" showSubtasks onToggleSubtasks={() => {}} />);
    const card = document.querySelector('[data-subtask-card="kid"]');
    expect(card.getAttribute('draggable')).toBe('false');
    expect(within(card).queryByLabelText(/to another status/)).toBeNull();
  });

  it('an editor can drag a subtask card', async () => {
    state = makeStore([parent, kid]);
    const { default: BoardView } = await import('./views/board');
    render(<BoardView visible={[parent, kid]} ctx={ctx} store={state} onOpen={() => {}} lockedProjectId="p1" showSubtasks onToggleSubtasks={() => {}} />);
    expect(document.querySelector('[data-subtask-card="kid"]').getAttribute('draggable')).toBe('true');
  });
});

// ── Timeline ────────────────────────────────────────────────────────────────
describe('Timeline with Show Subtasks', () => {
  const parent = T('parent', { title: 'Pour slab', startOn: '2026-10-01', dueOn: '2026-10-05' });
  const kid = T('kid', { title: 'Order rebar', parentTaskId: 'parent', startOn: '2026-10-02', dueOn: '2026-10-03' });
  const orphan = T('orphan', { title: 'Book crane', parentTaskId: 'undated', startOn: '2026-10-04', dueOn: '2026-10-04' });
  const undated = T('undated', { title: 'Site prep' });
  afterEach(() => phone(false));

  async function show(props = {}, roles) {
    state = makeStore([parent, kid, orphan, undated], roles ? { roles } : undefined);
    const { TimelineView } = await import('./views/more');
    return render(<TimelineView tasks={[parent, kid, orphan]} onOpen={() => {}} nameOf={(e) => e} taskById={state.taskById}
      showSubtasks onToggleSubtasks={() => {}} {...props} />);
  }

  it('draws the subtask right under its parent, indented, and folds it away', async () => {
    await show();
    const rows = [...document.querySelectorAll('[data-timeline-row]')].map((el) => el.getAttribute('data-timeline-row'));
    expect(rows).toEqual(['parent', 'kid', 'orphan']);
    const indent = (id) => parseFloat(document.querySelector(`[data-timeline-row="${id}"]`).style.paddingLeft);
    expect(indent('kid')).toBeGreaterThan(indent('parent'));
    expect(screen.getByText('in Site prep')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Hide the subtasks of Pour slab'));
    expect(document.querySelector('[data-timeline-row="kid"]')).toBeNull();
    expect(screen.getByLabelText('Show the subtasks of Pour slab')).toBeTruthy();
  });

  it('read-only bars do not drag', async () => {
    await show({}, { p1: 'viewer' });
    const bar = screen.getByLabelText('Order rebar');
    pointer(bar, 'pointerdown', 26);
    pointer(bar, 'pointermove', 90);
    await act(async () => { pointer(bar, 'pointerup', 90); });
    expect(rescheduleTask).not.toHaveBeenCalled();
    expect(screen.getByText(/You can view these dates/)).toBeTruthy();
  });

  it('an editor drags a subtask bar like any other', async () => {
    await show();
    const bar = screen.getByLabelText('Order rebar');
    pointer(bar, 'pointerdown', 26);
    pointer(bar, 'pointermove', 78);
    await act(async () => { pointer(bar, 'pointerup', 78); });
    expect(rescheduleTask).toHaveBeenCalledWith('kid', { start_on: '2026-10-04', due_on: '2026-10-05' });
  });

  it('keeps the phone layout: a narrow pinned title column', async () => {
    phone(true);
    await show();
    const col = screen.getByTestId('timeline-titles');
    expect(col.style.position).toBe('sticky');
    expect(col.style.width).toBe('128px');
    expect(document.querySelectorAll('[data-timeline-row]').length).toBe(3);
  });

  it('with the switch off nothing changes', async () => {
    await show({ showSubtasks: false, tasks: [parent] });
    expect(document.querySelectorAll('[data-timeline-row]').length).toBe(0);
    expect(screen.getByRole('button', { name: /Show Subtasks/ }).getAttribute('aria-pressed')).toBe('false');
  });
});
