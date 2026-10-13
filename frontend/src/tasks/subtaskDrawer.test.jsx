import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Subtasks in the task drawer (Sagar, Oct 13 2026): a subtask says whose it is
// under its title, and closing, deleting or completing one goes back to the
// main task instead of shutting the drawer and losing your place.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));

const parent = { id: 'p', title: 'Remove IT items duplicates', status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  subtaskIds: ['s'], commentIds: [], attachmentIds: [], followerIds: [], tags: [], customFieldValues: {}, completed: false };
const sub = { ...parent, id: 's', title: 'Check the Nexus portal', parentTaskId: 'p', subtaskIds: [] };

let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));

function makeStore() {
  const tasks = [parent, sub];
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), teams: [], projects: [], customFields: [],
    statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } }, statusOrder: ['not_started'],
    statusOrderFor: () => ['not_started'], loading: false,
    projectName: () => '', teamName: () => '', nameOf: (e) => e, myEmail: 'me@x.com',
    updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
    getComments: vi.fn(() => Promise.resolve([])), addComment: vi.fn(), offerUndo: vi.fn(),
    toggleComplete: vi.fn(() => Promise.resolve()), refresh: vi.fn(), createTeam: vi.fn(),
  };
}

const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');

beforeEach(() => {
  state = makeStore();
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const title = () => screen.getAllByRole('textbox').find((el) => el.value === parent.title || el.value === sub.title)?.value;

describe('a subtask in the task drawer', () => {
  it('says whose subtask it is, under the title', () => {
    render(<TaskDetailDrawer taskId="s" onClose={() => {}} />);
    expect(screen.getByTestId('subtask-of').textContent).toContain('Subtask of');
    expect(screen.getByTestId('subtask-of').textContent).toContain(parent.title);
  });

  it('the main task name opens the main task', () => {
    render(<TaskDetailDrawer taskId="s" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('Open the main task'));
    expect(title()).toBe(parent.title);
    expect(screen.queryByTestId('subtask-of')).toBeNull();
  });

  it('Close on a subtask opened from its main task goes back to the main task', () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="p" onClose={onClose} />);
    // The Overview's Subtasks section is open whenever there are subtasks.
    fireEvent.click(screen.getAllByText(sub.title)[0]);
    expect(title()).toBe(sub.title);
    // The header Close button (the title row has a back arrow saying the same).
    fireEvent.click(screen.getAllByTitle(`Back to ${parent.title}`).find((b) => b.querySelector(".lucide-arrow-right-to-line")));
    expect(title()).toBe(parent.title);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('deleting a subtask lands on the main task, not a closed drawer', () => {
    const onClose = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TaskDetailDrawer taskId="s" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('More Actions'));
    fireEvent.click(screen.getByText('Delete Subtask'));
    expect(state.deleteTask).toHaveBeenCalledWith('s');
    expect(onClose).not.toHaveBeenCalled();
    expect(title()).toBe(parent.title);
  });

  it('completing a subtask goes back to the main task', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    state.toggleComplete = vi.fn(() => { state.taskById.s = { ...sub, completed: true }; return Promise.resolve(); });
    const { rerender } = render(<TaskDetailDrawer taskId="s" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Mark Complete'));
    rerender(<TaskDetailDrawer taskId="s" onClose={onClose} />);
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(700); });
    vi.useRealTimers();
    expect(onClose).not.toHaveBeenCalled();
    expect(title()).toBe(parent.title);
  });

  it('a top-level task closes as before', () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="p" onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});


// Ordering, dragging and defaults (Oct 13 2026).
describe('subtasks of a main task', () => {
  const kids = [
    { ...sub, id: 'a', title: 'Alpha (no date)', dueOn: '', priority: 'urgent', position: 1 },
    { ...sub, id: 'b', title: 'Bravo (11/20, low)', dueOn: '2026-11-20', priority: 'low', position: 2 },
    { ...sub, id: 'c', title: 'Charlie (11/20, high)', dueOn: '2026-11-20', priority: 'high', position: 3 },
    { ...sub, id: 'd', title: 'Delta (11/05)', dueOn: '2026-11-05', priority: 'medium', position: 4 },
  ];
  const withKids = (parentPatch = {}) => {
    const p = { ...parent, followerIds: ['ankush@x.com', 'neil@x.com'], teamId: 'team-it', projectId: 'proj-it', ...parentPatch };
    const tasks = [p, ...kids];
    state = { ...makeStore(), tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])) };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
  };
  const shownOrder = () => [...document.querySelectorAll('[data-subtask-row]')].map((el) => el.getAttribute('data-subtask-row'));

  it('are shown without opening anything', () => {
    withKids();
    expect(shownOrder().length).toBe(4);
  });

  it('go by due date, then priority, undated last', () => {
    withKids();
    expect(shownOrder()).toEqual(['d', 'c', 'b', 'a']);
  });

  it('keep the order they were dragged into once ordered by hand', () => {
    withKids({ subtaskOrder: 'manual' });
    expect(shownOrder()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('Sort by Due Date')).toBeTruthy();
  });

  it('move with the six-dot handle from the keyboard', () => {
    withKids();
    fireEvent.keyDown(screen.getByLabelText('Move Bravo (11/20, low) (drag, or Up / Down)'), { key: 'ArrowUp' });
    // Shown d c b a -> d b c a: numbered 1-4 in the new order (only the rows
    // whose number changes are written - b and c already hold 2 and 3), and
    // the main task switched to manual order.
    expect(state.updateTask).toHaveBeenCalledWith('d', { position: 1 });
    expect(state.updateTask).toHaveBeenCalledWith('a', { position: 4 });
    expect(state.updateTask).not.toHaveBeenCalledWith('b', expect.anything());
    expect(state.updateTask).toHaveBeenCalledWith('p', { subtaskOrder: 'manual' });
  });

  it('drag and drop onto another row', () => {
    withKids({ subtaskOrder: 'manual' });
    const row = (id) => document.querySelector(`[data-subtask-row="${id}"]`);
    // Alpha dragged onto Charlie. (jsdom's drag events carry no pointer
    // position, so this reads as the lower half - Alpha lands after Charlie.)
    fireEvent.mouseDown(screen.getByLabelText('Move Alpha (no date) (drag, or Up / Down)'));
    fireEvent.dragStart(row('a'), { dataTransfer: { setData() {}, effectAllowed: '' } });
    fireEvent.dragOver(row('c'));
    fireEvent.drop(row('c'));
    // a b c d -> b c a d
    expect(state.updateTask).toHaveBeenCalledWith('b', { position: 1 });
    expect(state.updateTask).toHaveBeenCalledWith('c', { position: 2 });
    expect(state.updateTask).toHaveBeenCalledWith('a', { position: 3 });
    expect(state.updateTask).not.toHaveBeenCalledWith('d', expect.anything());
  });

  it('the row itself does not start a drag - only its handle', () => {
    withKids({ subtaskOrder: 'manual' });
    const row = (id) => document.querySelector(`[data-subtask-row="${id}"]`);
    fireEvent.dragStart(row('a'), { dataTransfer: { setData() {}, effectAllowed: '' } });
    fireEvent.dragOver(row('c'));
    fireEvent.drop(row('c'));
    expect(state.updateTask).not.toHaveBeenCalled();
  });

  it("a new subtask gets the main task's collaborators and team, and no due date", async () => {
    withKids();
    const box = screen.getAllByPlaceholderText('Add subtask')[0];
    fireEvent.change(box, { target: { value: 'Label the switches' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Label the switches', parentTaskId: 'p', followerIds: ['ankush@x.com', 'neil@x.com'],
      teamId: 'team-it', projectId: 'proj-it', dueOn: '',
    }));
  });
});

// Filing a task under a Custom section from the task itself (Oct 13 2026).
describe('the Section row', () => {
  it("offers the project's Custom sections and files the task", () => {
    const t = { ...parent, projectId: 'proj', sectionId: 'old-asana' };
    state = { ...makeStore(), tasks: [t], taskById: { p: t },
      sections: [
        { id: 'old-asana', projectId: 'proj', name: 'Not Started', position: 0 },
        { id: 's1', projectId: 'proj', name: 'Annual Recurring', position: 1, custom: true },
      ] };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    const box = screen.getByLabelText('Section');
    // The imported Asana section is not offered, so the task reads as unfiled.
    expect(box.value).toBe('');
    expect([...box.options].map((o) => o.textContent)).toEqual(['No Section', 'Annual Recurring']);
    fireEvent.change(box, { target: { value: 's1' } });
    expect(state.updateTask).toHaveBeenCalledWith('p', { sectionId: 's1' });
  });

  it('is not there when the project has no sections', () => {
    const t = { ...parent, projectId: 'proj' };
    state = { ...makeStore(), tasks: [t], taskById: { p: t }, sections: [] };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    expect(screen.queryByLabelText('Section')).toBeNull();
  });
});
