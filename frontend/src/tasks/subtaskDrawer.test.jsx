import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';

// Subtasks in the task drawer (Sagar, Oct 13 2026): a subtask says whose it is
// under its title, and closing, deleting or completing one goes back to the
// main task instead of shutting the drawer and losing your place.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => () => Promise.resolve(k === 'getPeopleDirectory'
  ? [{ email: 'sai@x.com', name: 'Sai Malladi' }, { email: 'ankush@x.com', name: 'Ankush Narkhede' }] : []) }) }));

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

const { default: TaskDetailDrawer, CommitNumberInput } = await import('./TaskDetailDrawer');

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

// Oct 13 2026: Subtasks, Approval and Comments open when they have something
// in them, folded when empty.
describe('folding sections on the Overview', () => {
  const expanded = (title) => screen.getAllByRole('button', { expanded: true }).some((b) => b.textContent.startsWith(title));
  const openTask = (patchTask) => {
    const t = { ...parent, subtaskIds: [], ...patchTask };
    state = { ...makeStore(), tasks: [t], taskById: { p: t } };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
  };

  it('are folded when empty', () => {
    openTask({ approvalStatus: 'none', commentIds: [] });
    expect(expanded('Subtasks')).toBe(false);
    expect(expanded('Approval')).toBe(false);
    expect(expanded('Comments')).toBe(false);
  });

  it('open when they have content', () => {
    openTask({ approvalStatus: 'pending', commentIds: ['c1', 'c2'] });
    expect(expanded('Approval')).toBe(true);
    expect(expanded('Comments')).toBe(true);
  });
});

// The Recurrence menu on the Overview (Oct 13 2026): the "Every" box could not
// be cleared (it snapped back to 1, so typing 2 made 12) and saved on every key.
describe('editing recurrence from the task Overview', () => {

  it('lets 1 be replaced by 2, and saves once', () => {
    const onCommit = vi.fn();
    render(<CommitNumberInput value={1} onCommit={onCommit} aria-label="n" />);
    const box = screen.getByLabelText('n');
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: '2' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(2);
  });

  it('puts the saved value back for nothing, zero or a fraction - and Escape', () => {
    const onCommit = vi.fn();
    render(<CommitNumberInput value={3} onCommit={onCommit} aria-label="n" />);
    const box = screen.getByLabelText('n');
    for (const bad of ['', '0', '1.5']) {
      fireEvent.change(box, { target: { value: bad } });
      fireEvent.blur(box);
      expect(box.value).toBe('3');
    }
    fireEvent.change(box, { target: { value: '9' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('3');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a count can be cleared', () => {
    const onCommit = vi.fn();
    render(<CommitNumberInput value={10} allowEmpty onCommit={onCommit} aria-label="n" />);
    const box = screen.getByLabelText('n');
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('Custom: every 2 weeks, and the last day cannot be unticked', () => {
    const t = { ...parent, status: 'recurring', recurrence: { freq: 'custom', unit: 'week', interval: 1, daysOfWeek: [1] } };
    state = { ...makeStore(), tasks: [t], taskById: { p: t } };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Every week on Mon'));
    fireEvent.click(screen.getByText('Custom'));
    const every = screen.getByLabelText('Repeat every');
    fireEvent.change(every, { target: { value: '' } });
    fireEvent.change(every, { target: { value: '2' } });
    fireEvent.blur(every);
    expect(state.updateTask).toHaveBeenCalledTimes(1);
    expect(state.updateTask).toHaveBeenCalledWith('p', expect.objectContaining({
      recurrence: { freq: 'custom', unit: 'week', interval: 2, daysOfWeek: [1] },
    }));
    // Monday is the only day: unticking it does nothing.
    state.updateTask.mockClear();
    fireEvent.click(screen.getByTitle('Monday'));
    expect(state.updateTask).not.toHaveBeenCalled();
  });
});

// Duplicate in the task's ... menu (Oct 13 2026).
describe('Duplicate Task', () => {
  const main = { ...parent, status: 'recurring', recurrence: { freq: 'weekly', daysOfWeek: [1], nextOccurrenceId: 'n1' },
    followerIds: ['neil@x.com'], customFieldValues: { prop: 'esc' }, priority: 'high' };
  const kid = { ...sub, id: 's', parentTaskId: 'p', title: 'Check the portal', priority: 'low', customFieldValues: { prop: 'esc' } };
  const copy = { ...main, id: 'copy', title: `${main.title} (copy)`, status: 'not_started', recurrence: null };
  const open = async () => {
    state = { ...makeStore(), tasks: [main, kid], taskById: { p: main, s: kid } };
    state.createTask = vi.fn((body) => {
      if (body.parentTaskId) return Promise.resolve({ id: 'copy-sub' });
      state.tasks = [...state.tasks, copy];
      state.taskById = { ...state.taskById, copy };
      return Promise.resolve({ id: 'copy' });
    });
    const view = render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('More Actions'));
    fireEvent.click(screen.getByText('Duplicate Task'));
    await screen.findByText('Bring Over');
    return view;
  };
  const run = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Duplicate' })); }); };

  it('asks what to bring over, then copies the task and its subtasks and opens the copy', async () => {
    const { rerender } = await open();
    // Oct 14 2026: the series is carried by default (one copy per entity,
    // each repeating) - untick Recurrence for a one-off.
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('Recurrence'));
    await run();
    const [first, second] = state.createTask.mock.calls.map((c) => c[0]);
    expect(first).toEqual(expect.objectContaining({
      title: `${main.title} (copy)`, status: 'not_started', priority: 'high',
      followerIds: ['neil@x.com'], customFieldValues: { prop: 'esc' },
    }));
    expect(first.recurrence).toBeUndefined();
    expect(second).toEqual(expect.objectContaining({ title: 'Check the portal', parentTaskId: 'copy', priority: 'low' }));
    expect(state.offerUndo).toHaveBeenCalled();
    rerender(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    expect(screen.getAllByRole('textbox').some((el) => el.value === `${main.title} (copy)`)).toBe(true);
  });

  it('keeps the recurrence (without the series marker) and leaves out what is unticked', async () => {
    await open();
    const dialog = screen.getByText('Bring Over').closest('div').parentElement;
    fireEvent.click(within(dialog).getByLabelText(/^Subtasks/));
    fireEvent.click(within(dialog).getByLabelText('Collaborators'));
    await run();
    const calls = state.createTask.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].recurrence).toEqual({ freq: 'weekly', daysOfWeek: [1] });
    expect(calls[0].status).toBe('recurring');
    expect(calls[0].followerIds).toEqual([]);
  });
});


// Editing a subtask's dates and people from the main task's list (Oct 13 2026).
describe('a subtask row', () => {
  const openMain = () => {
    const kid = { ...sub, id: 's', parentTaskId: 'p', title: 'Undeposited fund _GSVC', dueOn: '2026-10-31', assigneeIds: ['sai@x.com'] };
    state = { ...makeStore(), tasks: [parent, kid], taskById: { p: parent, s: kid } };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
  };
  const stillOnMain = () => expect(screen.getAllByRole('textbox').some((el) => el.value === parent.title)).toBe(true);

  it('adds a second assignee without opening the subtask', async () => {
    openMain();
    fireEvent.click(screen.getByLabelText('Assignees of Undeposited fund _GSVC'));
    const ankush = await screen.findByText('Ankush Narkhede');
    fireEvent.click(ankush.closest('label').querySelector('input'));
    expect(state.updateTask).toHaveBeenCalledWith('s', { assigneeIds: ['sai@x.com', 'ankush@x.com'] });
    stillOnMain();
  });

  it('changes the due date without opening the subtask', () => {
    openMain();
    fireEvent.click(screen.getByTitle('Change due date'));
    fireEvent.click(screen.getByText('Clear'));
    expect(state.updateTask).toHaveBeenCalledWith('s', { dueOn: '' });
    stillOnMain();
  });
});

// The Add subtask row's date (Oct 13 2026): the Nexus calendar, not the
// browser's date picker, which opened half off-screen.
describe('the Add subtask row date', () => {
  it('opens the Nexus calendar and the date goes onto the new subtask', () => {
    state = { ...makeStore(), tasks: [{ ...parent, subtaskIds: [] }], taskById: { p: { ...parent, subtaskIds: [] } } };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    // No subtasks yet, so the section starts folded - open it.
    fireEvent.click(screen.getAllByRole('button', { expanded: false }).find((b) => b.textContent.startsWith('Subtasks')));
    expect(document.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(screen.getAllByTitle('Due Date').find((b) => b.tagName === 'BUTTON'));
    fireEvent.click(screen.getByText('Today'));
    const box = screen.getAllByPlaceholderText('Add subtask')[0];
    fireEvent.change(box, { target: { value: 'File the W9s' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'File the W9s', dueOn: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    }));
  });
});

// Neil, Oct 14 2026: a subtask is the main task's child.
describe('subtasks follow the main task', () => {
  const main = { ...parent, assigneeIds: ['sai@x.com'], followerIds: ['neil@x.com'], priority: 'high',
    customFieldValues: { ent: 'rjk' }, recurrence: { freq: 'yearly' }, status: 'recurring' };
  const kid = { ...sub, followerIds: ['neil@x.com'], customFieldValues: { ent: 'rjk' } };
  const openMain = () => {
    state = { ...makeStore(), tasks: [main, kid], taskById: { p: main, s: kid },
      customFields: [{ id: 'ent', name: 'Entities', type: 'select', options: [{ id: 'rjk', label: 'RJK' }, { id: 'aus', label: 'Greens Austin' }] }] };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
  };

  it('a new subtask starts with the main task’s people, priority and field values', async () => {
    openMain();
    fireEvent.change(screen.getByPlaceholderText('Add subtask'), { target: { value: 'Collect K-1s' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
    expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Collect K-1s', parentTaskId: 'p', assigneeIds: ['sai@x.com'], followerIds: ['neil@x.com'],
      priority: 'high', customFieldValues: { ent: 'rjk' },
    }));
  });

  it('changing the Entity on the main task offers it to the subtasks', () => {
    openMain();
    fireEvent.change(screen.getByDisplayValue('RJK'), { target: { value: 'aus' } });
    expect(state.updateTask).toHaveBeenCalledWith('p', { customFieldValues: { ent: 'aus' } });
    expect(screen.getByText('Change Entities on the 1 subtask too?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to Subtasks' }));
    expect(state.updateTask).toHaveBeenCalledWith('s', { customFieldValues: { ent: 'aus' } });
  });

  it('a subtask of a repeating task says it repeats with it, and can stop', () => {
    state = { ...makeStore(), tasks: [main, kid], taskById: { p: main, s: kid } };
    render(<TaskDetailDrawer taskId="s" onClose={() => {}} />);
    expect(screen.getByText(/Repeats with the main task/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recurrence' }));
    fireEvent.click(screen.getByText('Does not repeat'));
    expect(state.updateTask).toHaveBeenCalledWith('s', expect.objectContaining({ recurrence: { skip: true } }));
  });

  it('a subtask can be given a schedule of its own', () => {
    state = { ...makeStore(), tasks: [main, kid], taskById: { p: main, s: kid } };
    render(<TaskDetailDrawer taskId="s" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recurrence' }));
    fireEvent.click(screen.getByText('Daily'));
    expect(state.updateTask).toHaveBeenCalledWith('s', { recurrence: { freq: 'daily' }, status: 'recurring' });
  });

  it("the add row's calendar has Repeat, and a new subtask can repeat on its own", async () => {
    openMain();
    fireEvent.change(screen.getByPlaceholderText('Add subtask'), { target: { value: 'Reconcile bank' } });
    fireEvent.click(screen.getAllByTitle('Due Date').at(-1));
    fireEvent.click(screen.getByTitle('With Main Task'));
    fireEvent.click(screen.getByText('Daily'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reconcile bank', recurrence: { freq: 'daily' }, status: 'recurring',
    })));
  });

  it('Status is a dropdown', () => {
    openMain();
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getByText('Not Started')).toBeTruthy();   // the menu's option
  });
});

// Tasks from tickets (Oct 14 2026): the task names the ticket it came from,
// and from a ticket's own Tasks list the link just goes back to it.
describe('From Ticket', () => {
  const fromTicket = { ...parent, id: 'ft', sourceTicketId: 'tk1', subtaskIds: [] };
  const ticket = { id: 'tk1', code: '000123', subject: 'Printer jam' };

  it('shows the ticket and goes back to it', () => {
    state = { ...makeStore(), tasks: [fromTicket], taskById: { ft: fromTicket }, tickets: [ticket] };
    const back = vi.fn();
    render(<TaskDetailDrawer taskId="ft" onClose={() => {}} onBackToTicket={back} />);
    fireEvent.click(screen.getByRole('button', { name: /Ticket #123 · Printer jam/ }));
    expect(back).toHaveBeenCalled();
  });

  it('is not shown on a task that has no ticket', () => {
    state = { ...makeStore(), tasks: [parent], taskById: { p: parent }, tickets: [ticket] };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    expect(screen.queryByText('From Ticket')).toBeNull();
  });

  it('the From Ticket filter keeps only tasks from tickets', async () => {
    const { matchesFilter, EMPTY_FILTER } = await import('./lib');
    const f = { ...EMPTY_FILTER, fromTicket: true };
    expect(matchesFilter(fromTicket, f)).toBe(true);
    expect(matchesFilter(parent, f)).toBe(false);
    expect(matchesFilter(parent, EMPTY_FILTER)).toBe(true);
  });
});

// Save as Template (Neil, Oct 14 2026): from the task's More Actions menu,
// keeping what is ticked.
describe('Save as Template', () => {
  it('saves the task as a template with the parts asked for', async () => {
    const saveTaskAsTemplate = vi.fn(() => Promise.resolve({ id: 'tpl1', name: 'Remove IT items duplicates' }));
    const kid = { ...sub, id: 's', parentTaskId: 'p' };
    state = { ...makeStore(), tasks: [parent, kid], taskById: { p: parent, s: kid }, saveTaskAsTemplate, deleteTemplate: vi.fn() };
    render(<TaskDetailDrawer taskId="p" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('More Actions'));
    fireEvent.click(screen.getByText('Save as Template'));
    const dialog = screen.getByRole('dialog', { name: /Save as Template/ });
    fireEvent.click(within(dialog).getByLabelText('Assignees'));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save Template' })); });
    expect(saveTaskAsTemplate).toHaveBeenCalledWith('p', {
      name: 'Remove IT items duplicates', description: '',
      parts: ['subtasks', 'followers', 'fields', 'description', 'checklist'],
    });
  });
});

describe('Save as Template on a task with no subtasks', () => {
  it('still lists Subtasks and Recurrence, greyed out with the reason', () => {
    const lone = { ...parent, id: 'l', subtaskIds: [] };
    state = { ...makeStore(), tasks: [lone], taskById: { l: lone }, saveTaskAsTemplate: vi.fn(), deleteTemplate: vi.fn() };
    render(<TaskDetailDrawer taskId="l" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('More Actions'));
    fireEvent.click(screen.getByText('Save as Template'));
    const dialog = screen.getByRole('dialog', { name: /Save as Template/ });
    expect(within(dialog).getByLabelText(/Subtasks/).disabled).toBe(true);
    expect(within(dialog).getByText(/this task has none/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Recurrence/).disabled).toBe(true);
    expect(within(dialog).getByText(/this task does not repeat/)).toBeTruthy();
  });
});

describe('Duplicate on a task with no subtasks', () => {
  it('still lists Subtasks and Recurrence, greyed out with the reason', () => {
    const lone = { ...parent, id: 'l', subtaskIds: [] };
    state = { ...makeStore(), tasks: [lone], taskById: { l: lone } };
    render(<TaskDetailDrawer taskId="l" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle('More Actions'));
    fireEvent.click(screen.getByText('Duplicate Task'));
    const dialog = screen.getByRole('dialog', { name: /Duplicate Task/ });
    expect(within(dialog).getByLabelText(/Subtasks/).disabled).toBe(true);
    expect(within(dialog).getByLabelText(/Recurrence/).disabled).toBe(true);
    expect(within(dialog).getByText(/this task does not repeat/)).toBeTruthy();
  });
});
