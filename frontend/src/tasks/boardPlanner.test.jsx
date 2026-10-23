// The Board, Planner-style (Neil, Oct 22 2026): the toolbar's Group drives
// the swimlanes (it used to change nothing on Board), a Columns choice, label
// lanes, Due Date columns through the Calendar's day move, and card previews.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';

const saveTaskTablePrefs = vi.fn(() => Promise.resolve({}));
let serverPrefs = {};
const updateTaskChecklistItem = vi.fn(() => Promise.resolve({ item: {}, task: { id: 't1', checklistDone: 1 } }));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined
    : k === 'saveTaskTablePrefs' ? (...a) => saveTaskTablePrefs(...a)
      : k === 'updateTaskChecklistItem' ? (...a) => updateTaskChecklistItem(...a)
        : k === 'getTaskAttachments' ? () => Promise.resolve(ATTACHMENTS)
          : () => Promise.resolve(k === 'getTaskTablePrefs' ? { prefs: serverPrefs } : [])) }),
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }));

const ME = 'me@greensglobal.com';
const ATTACHMENTS = [
  { id: 'f1', name: 'site.jpg', kind: 'image', url: 'http://localhost:8000/files/view?u=a', versionGroup: 'f0', version: 2 },
  { id: 'f2', name: 'spec.pdf', kind: 'doc', url: 'http://localhost:8000/files/view?u=b' },
  { id: 'f3', name: 'Drawings', kind: 'egnyte', url: 'https://greens.egnyte.com/x' },
  // A web link whose name and address look like an image - still a link.
  { id: 'f4', name: 'photo.png', kind: 'link', url: 'https://example.com/photo.png' },
];
const base = { status: 'not_started', priority: 'medium', assigneeIds: [], followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, customFieldValues: {}, projectId: 'p1', startOn: '', dueOn: '' };
const statusMeta = { not_started: { label: 'Not Started', color: '#888' }, in_progress: { label: 'In Progress', color: '#48f' }, completed: { label: 'Completed', color: '#4a4' } };
let store;
const makeStore = (tasks, { role = 'editor', defaultView = null } = {}) => {
  const p = { id: 'p1', name: 'Ops', ownerId: 'boss@greensglobal.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: role }, defaultView };
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: [p], teams: [], portfolios: [], sections: [],
    customFields: [], customStatuses: [], savedViews: [], templates: [], intakeForms: [], bookmarks: new Set(), loading: false, myEmail: ME,
    statusMeta, statusOrder: ['not_started', 'in_progress', 'completed'], statusOrderFor: () => ['not_started', 'in_progress', 'completed'],
    nameOf: (e) => e, projectName: () => 'Ops', teamName: () => '', teamById: () => null,
    projectById: (id) => (id === 'p1' ? p : null), portfolioById: () => null,
    toggleComplete: () => {}, toggleBookmark: () => Promise.resolve(), createTask: vi.fn(() => Promise.resolve({})),
    updateTask: vi.fn((id, patch) => Promise.resolve({ ...tasks.find((t) => t.id === id), ...patch })),
    setStatus: vi.fn(() => Promise.resolve({})), updateProject: vi.fn(() => Promise.resolve(p)),
    offerUndo: vi.fn(), applyServerTask: vi.fn(),
  };
};
vi.mock('./TasksContext', async (importOriginal) => ({ ...(await importOriginal()), useTasks: () => store }));

const { default: TasksWorkspace } = await import('./TasksWorkspace');
const { default: BoardView } = await import('./views/board');
const { __setTablePrefsCache } = await import('./tableCols');
const { ShowOnCardSelect } = await import('./CardPreview');
const { __setLabelColors } = await import('./labels');

beforeEach(() => {
  serverPrefs = {};
  __setTablePrefsCache({});
  saveTaskTablePrefs.mockClear();
  updateTaskChecklistItem.mockClear();
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});
afterEach(() => { vi.useRealTimers(); });

const lanesShown = () => [...document.querySelectorAll('[data-board-lane]')].map((el) => el.getAttribute('data-board-lane'));
const openMenu = async (label) => { await act(async () => { fireEvent.click(screen.getByTitle(label)); }); };
const pick = async (name) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('the toolbar Group menu drives the board (it did nothing before)', () => {
  const tasks = [
    { ...base, id: 't1', code: 'T-1', title: 'Shared', assigneeIds: ['a@x.com', 'b@x.com'], tags: ['Field'] },
    { ...base, id: 't2', code: 'T-2', title: 'Solo', assigneeIds: ['b@x.com'] },
  ];

  it('Group > Assignee turns the board into assignee lanes; the List keeps its own grouping', async () => {
    store = makeStore(tasks);
    render(<TasksWorkspace lockedProjectId="p1" />);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^Board$/ })[0]); });
    expect(lanesShown()).toEqual([]);                         // the List's "status" is no lane: None
    await openMenu('Group');
    // Only what makes sense as a lane - no Status, no Custom, no Project on a project's board.
    for (const name of ['None', 'Assignee', 'Priority', 'Label']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Custom' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull();
    await pick('Assignee');
    expect(lanesShown()).toEqual(['a@x.com', 'b@x.com']);
    // The shared task is in both people's lanes.
    const laneB = document.querySelector('[data-board-lane="b@x.com"]');
    expect(within(laneB).getByText('Shared')).toBeInTheDocument();
    // Remembered for the board in this project - the List's grouping untouched.
    const call = saveTaskTablePrefs.mock.calls.filter(([table]) => table === 'projectViews').at(-1);
    expect(call[1].data.p1).toEqual({ view: 'board', board: { lanes: 'assignee' } });
    // No second swimlane control on the board itself.
    expect(screen.queryByText(/Swimlanes:/)).toBeNull();
  });

  it('Columns > Priority makes priority columns and takes Priority out of Group', async () => {
    store = makeStore(tasks);
    render(<TasksWorkspace lockedProjectId="p1" />);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^Board$/ })[0]); });
    await openMenu('Columns');
    expect(screen.queryByRole('button', { name: 'Section' })).toBeNull();   // no Custom sections here
    await pick('Priority');
    const cols = [...document.querySelectorAll('[data-board-column]')].map((el) => el.getAttribute('data-board-column'));
    expect(cols).toEqual(['urgent', 'high', 'medium', 'low']);
    await openMenu('Group');
    expect(screen.queryByRole('button', { name: 'Priority' })).toBeNull();
  });

  it('a stored grouping the board cannot use falls back to None (a default Board saved as "status")', async () => {
    store = makeStore(tasks, { defaultView: { view: 'board', group: 'status' } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    expect(screen.getByTestId('board-columns')).toBeInTheDocument();
    expect(lanesShown()).toEqual([]);
  });

  it('a default Board saved before lanes existed opens with none (its group is the List\'s)', () => {
    store = makeStore(tasks, { defaultView: { view: 'board', group: 'assignee' } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    expect(screen.getByTestId('board-columns')).toBeInTheDocument();
    expect(lanesShown()).toEqual([]);
  });

  it('a default Board with lanes and columns opens that way', async () => {
    store = makeStore(tasks, { defaultView: { view: 'board', group: 'status', lanes: 'label', columns: 'priority' } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    expect(lanesShown()).toEqual(['Field', '__none']);
    // The lane header is the shared label pill (labels.js), in the label's color.
    const pill = document.querySelector('[data-board-lane="Field"] .nx-tag');
    expect(pill.textContent).toBe('Field');
    expect(pill.getAttribute('data-tone')).toBeTruthy();
  });
});

const ctx = { nameOf: (e) => e, projectName: () => 'Ops', teamName: () => '' };
const boardStore = (tasks) => ({ ...makeStore(tasks), tasks });
const dragTo = async (title, selector) => {
  fireEvent.dragStart(screen.getAllByText(title)[0].closest('[data-task-row]'));
  const zone = document.querySelector(selector);
  fireEvent.dragOver(zone);
  await act(async () => { fireEvent.drop(zone); });
};

describe('label lanes', () => {
  const tasks = [
    { ...base, id: 't1', title: 'Two labels', tags: ['Alpha', 'Beta', 'Keep'] },
    { ...base, id: 't2', title: 'Beta only', tags: ['Beta'] },
    { ...base, id: 't3', title: 'Bare', tags: [] },
  ];
  const renderLabels = () => {
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="label" columns="status" />);
  };
  const dragFromLane = async (title, fromLane, toLane) => {
    const card = within(document.querySelector(`[data-board-lane="${fromLane}"]`)).getByText(title).closest('[data-task-row]');
    fireEvent.dragStart(card);
    const zone = document.querySelector(`[data-board-lane="${toLane}"] [data-board-zone="not_started"]`);
    fireEvent.dragOver(zone);
    await act(async () => { fireEvent.drop(zone); });
  };

  it('a task with several labels is in each lane, and No Label comes last', () => {
    renderLabels();
    expect(lanesShown()).toEqual(['Alpha', 'Beta', 'Keep', '__none']);
    expect(within(document.querySelector('[data-board-lane="Alpha"]')).getByText('Two labels')).toBeInTheDocument();
    expect(within(document.querySelector('[data-board-lane="Beta"]')).getByText('Two labels')).toBeInTheDocument();
    expect(within(document.querySelector('[data-board-lane="__none"]')).getByText('No Label')).toBeInTheDocument();
  });

  it('lane A to lane B removes A and adds B, touching nothing else', async () => {
    renderLabels();
    await dragFromLane('Beta only', 'Beta', 'Alpha');
    expect(store.updateTask).toHaveBeenLastCalledWith('t2', { tags: ['Alpha'] });
    await dragFromLane('Two labels', 'Alpha', 'Beta');
    expect(store.updateTask).toHaveBeenLastCalledWith('t1', { tags: ['Beta', 'Keep'] });
    await dragFromLane('Bare', '__none', 'Keep');
    expect(store.updateTask).toHaveBeenLastCalledWith('t3', { tags: ['Keep'] });
    await dragFromLane('Two labels', 'Keep', '__none');
    expect(store.updateTask).toHaveBeenLastCalledWith('t1', { tags: ['Alpha', 'Beta'] });
  });
});

describe('labels on the board (labels.js)', () => {
  afterEach(() => { __setLabelColors(null); });
  it('one lane per label however it is spelled, named and colored as the company map says', () => {
    __setLabelColors({ map: { urgent: { name: 'URGENT', color: 'red' } } });
    const tasks = [
      { ...base, id: 'u1', title: 'Lower', tags: ['urgent'] },
      { ...base, id: 'u2', title: 'Upper', tags: ['Urgent ', 'Field'] },
    ];
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="label" columns="status" />);
    expect(lanesShown()).toEqual(['Field', 'URGENT']);
    const lane = document.querySelector('[data-board-lane="URGENT"]');
    expect(within(lane).getByText('Lower')).toBeInTheDocument();
    expect(within(lane).getByText('Upper')).toBeInTheDocument();
    expect(lane.querySelector('.nx-tag').getAttribute('data-tone')).toBe('red');
  });

  it('a card shows its labels as the shared strip', () => {
    const tasks = [{ ...base, id: 'c1', title: 'Labeled', tags: ['Alpha', 'Beta', 'Gamma', 'Delta'] }];
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="status" />);
    const card = screen.getByText('Labeled').closest('[data-task-row]');
    const strip = card.querySelector('[data-labels]');
    expect([...strip.querySelectorAll('.nx-tag')].map((el) => el.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(strip.textContent).toContain('+1');
  });
});

describe('Due Date columns use the Calendar day move', () => {
  const tasks = [
    { ...base, id: 'a', title: 'Pour Footings', startOn: '2026-10-19', dueOn: '2026-10-21' },
    { ...base, id: 'b', title: 'Late One', dueOn: '2026-10-01' },
    { ...base, id: 'c', title: 'Undated' },
  ];
  const setup = (saved) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));   // Tue Oct 20 2026, local
    store = boardStore(tasks);
    if (saved) store.updateTask = vi.fn((id, patch) => Promise.resolve(saved(id, patch)));
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="due" />);
  };

  it('buckets the cards and moves due and start together, with Undo', async () => {
    setup();
    expect(within(document.querySelector('[data-board-column="tomorrow"]')).getByText('Pour Footings')).toBeInTheDocument();
    expect(within(document.querySelector('[data-board-column="overdue"]')).getByText('Late One')).toBeInTheDocument();
    expect(within(document.querySelector('[data-board-column="none"]')).getByText('Undated')).toBeInTheDocument();
    await dragTo('Pour Footings', '[data-board-column="nextweek"]');
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '2026-10-25', startOn: '2026-10-23' });
    expect(store.offerUndo.mock.calls[0][0]).toBe('Moved to 10/25/2026');
  });

  it('No Date clears the date; an undated card takes the bucket\'s first day', async () => {
    setup();
    await dragTo('Late One', '[data-board-column="none"]');
    expect(store.updateTask).toHaveBeenLastCalledWith('b', { dueOn: '' });
    expect(store.offerUndo.mock.calls.at(-1)[0]).toBe('Due date removed');
    await dragTo('Undated', '[data-board-column="today"]');
    expect(store.updateTask).toHaveBeenLastCalledWith('c', { dueOn: '2026-10-20' });
    expect(store.offerUndo.mock.calls.at(-1)[0]).toBe('Scheduled for 10/20/2026');
  });

  it('a first date awaiting approval cannot be dragged; No Date refuses a live repeating occurrence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));
    const more = [
      { ...base, id: 'w', title: 'Waiting', dueAgreement: 'extension_requested', dueProposal: { dueOn: '2026-10-30' } },
      { ...base, id: 'r', title: 'Weekly', dueOn: '2026-10-21', status: 'recurring', recurrence: { freq: 'weekly', daysOfWeek: [3] } },
    ];
    store = boardStore(more);
    render(<BoardView visible={more} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="due" />);
    expect(screen.getByText('Waiting').closest('[data-task-row]').getAttribute('draggable')).toBe('false');
    await dragTo('Weekly', '[data-board-column="none"]');
    expect(store.updateTask).not.toHaveBeenCalled();
    await dragTo('Weekly', '[data-board-column="later"]');
    expect(store.updateTask).toHaveBeenCalledWith('r', { dueOn: '2026-11-01' });
  });

  it('a completed card sits in Completed, not Overdue, and takes no day moves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));
    const more = [{ ...base, id: 'd', title: 'Done Late', dueOn: '2026-10-01', completed: true, status: 'completed' }];
    store = boardStore(more);
    render(<BoardView visible={more} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="due" />);
    expect(within(document.querySelector('[data-board-column="completed"]')).getByText('Done Late')).toBeInTheDocument();
    expect(within(document.querySelector('[data-board-column="overdue"]')).queryByText('Done Late')).toBeNull();
    await dragTo('Done Late', '[data-board-column="today"]');
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it('the card\'s Move To menu offers the due-date columns from the keyboard, through the same day move', async () => {
    setup();
    fireEvent.click(screen.getByLabelText('Move Pour Footings to another column'));
    const menu = await screen.findByRole('menu', { name: 'Move To' });
    const due = within(within(menu).getByRole('group', { name: 'Due Date' })).getAllByRole('menuitem');
    expect(due.map((b) => b.textContent)).toEqual(['Today', 'Tomorrow', 'This Week', 'Next Week', 'Later', 'No Date']);
    expect(due.find((b) => b.textContent === 'Tomorrow').disabled).toBe(true);   // where it is now
    expect(within(menu).getByRole('group', { name: 'Status' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(due.find((b) => b.textContent === 'Next Week')); });
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '2026-10-25', startOn: '2026-10-23' });
    expect(store.offerUndo).toHaveBeenCalled();
  });

  it('Overdue takes no drops, and a move held for approval offers no Undo', async () => {
    setup((id, patch) => ({ ...tasks[0], dueAgreement: 'extension_requested', dueProposal: { dueOn: patch.dueOn } }));
    await dragTo('Pour Footings', '[data-board-column="overdue"]');
    expect(store.updateTask).not.toHaveBeenCalled();
    await dragTo('Pour Footings', '[data-board-column="later"]');
    expect(store.updateTask).toHaveBeenCalledWith('a', { dueOn: '2026-11-01', startOn: '2026-10-30' });
    expect(store.offerUndo).not.toHaveBeenCalled();
  });
});

describe('card previews', () => {
  const tasks = [
    { ...base, id: 't1', title: 'With Steps', cardPreview: { kind: 'checklist', items: [1, 2, 3, 4, 5].map((n) => ({ id: `i${n}`, title: `Step ${n}`, assigneeId: null })), more: 2 } },
    { ...base, id: 't2', title: 'With Photo', cardPreview: { kind: 'image', id: 'f1', name: 'site.jpg', url: 'http://localhost:8000/files/view?u=x' } },
    { ...base, id: 't3', title: 'With Text', cardPreview: { kind: 'description', text: '<b>Bold</b> & more' } },
  ];

  it('draws the cover lazily, the open steps with "+N more", and text as text', () => {
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="status" />);
    const img = screen.getByTestId('card-preview-image');
    expect(img.getAttribute('alt')).toBe('site.jpg');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.style.maxHeight).toBe('140px');
    expect(img.style.objectFit).toBe('cover');
    expect(within(screen.getByTestId('card-preview-checklist')).getAllByRole('checkbox')).toHaveLength(5);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    const text = screen.getByTestId('card-preview-text');
    expect(text.textContent).toBe('<b>Bold</b> & more');
    expect(text.querySelector('b')).toBeNull();
  });

  it('an editor ticks a step on the card through the checklist API, without opening the card', async () => {
    store = boardStore(tasks);
    const onOpen = vi.fn();
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={onOpen} lockedProjectId="p1" group="none" columns="status" />);
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Step 2' })); });
    expect(updateTaskChecklistItem).toHaveBeenCalledWith('i2', { done: true });
    expect(store.applyServerTask).toHaveBeenCalledWith({ id: 't1', checklistDone: 1 });
    expect(screen.getByRole('checkbox', { name: 'Step 2' }).checked).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a viewer sees the steps but cannot tick them', () => {
    store = { ...boardStore(tasks), projects: [{ id: 'p1', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: 'viewer' } }] };
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="status" />);
    expect(screen.getByRole('checkbox', { name: 'Step 1' }).disabled).toBe(true);
  });

  it('the Card Previews switch hides them', () => {
    store = boardStore(tasks);
    const toggle = vi.fn();
    const { rerender } = render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="status" cardPreviews onToggleCardPreviews={toggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Card Previews/ }));
    expect(toggle).toHaveBeenCalled();
    rerender(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="status" cardPreviews={false} onToggleCardPreviews={toggle} />);
    expect(screen.queryByTestId('card-preview-image')).toBeNull();
    expect(screen.queryByTestId('card-preview-checklist')).toBeNull();
  });
});

describe('My Tasks board (no toolbar Group there)', () => {
  it('keeps its own Group and Columns menus, one of each', async () => {
    const tasks = [{ ...base, id: 't1', title: 'Mine', assigneeIds: [ME], tags: ['Field'] }];
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} defaultAssigneeId={ME} />);
    expect(screen.getAllByRole('button', { name: 'Group' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Columns' })).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Group' })); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Label' })); });
    expect(lanesShown()).toEqual(['Field']);
  });
});

describe('saved views on Board', () => {
  const tasks = [{ ...base, id: 't1', title: 'Labeled', tags: ['Field'], dueOn: '' }];

  it('applying a saved Board view sets its lanes and columns in ONE write, leaving the List alone', async () => {
    store = { ...makeStore(tasks), savedViews: [{ id: 'v1', name: 'Due Board', view: 'board', group: 'label', boardColumns: 'due', filters: {}, sort: { key: 'title', dir: 'asc' } }] };
    render(<TasksWorkspace lockedProjectId="p1" />);
    await openMenu('Saved Views');
    await pick('Due Board');
    expect(lanesShown()).toEqual(['Field']);
    expect(document.querySelector('[data-board-zone="none"]')).toBeTruthy();
    const writes = saveTaskTablePrefs.mock.calls.filter(([table]) => table === 'projectViews');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].data.p1).toEqual({ view: 'board', board: { lanes: 'label', columns: 'due' } });
  });

  it('saving from Board keeps the lanes as the group and the columns', async () => {
    store = { ...makeStore(tasks), createSavedView: vi.fn(() => Promise.resolve({})) };
    __setTablePrefsCache({ projectViews: { data: { p1: { view: 'board', board: { lanes: 'label', columns: 'priority' } } } } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    await openMenu('Saved Views');
    await act(async () => { fireEvent.click(screen.getByText(/Save Current View/i)); });
    fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'Mine' } });
    await act(async () => { fireEvent.keyDown(screen.getByPlaceholderText(/name/i), { key: 'Enter' }); });
    expect(store.createSavedView).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mine', view: 'board', group: 'label', boardColumns: 'priority' }));
  });
});

describe('Show On Card in the drawer', () => {
  it('offers Automatic / Checklist / Description / None and the task\'s image files only', async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(<ShowOnCardSelect task={{ id: 't1', attachmentIds: ['f1', 'f2', 'f3', 'f4'], cardPreviewMode: '' }} onChange={onChange} />);
    });
    const select = screen.getByRole('combobox', { name: 'Show On Card' });
    expect([...select.options].map((o) => o.textContent)).toEqual(['Automatic', 'Checklist', 'Description', 'None', 'site.jpg']);
    fireEvent.change(select, { target: { value: 'image:f1' } });
    expect(onChange).toHaveBeenCalledWith('image:f1');
  });

  it('a picked file that has a newer version since still reads as that file', async () => {
    await act(async () => {
      render(<ShowOnCardSelect task={{ id: 't1', attachmentIds: ['f1'], cardPreviewMode: 'image:f0' }} onChange={() => {}} />);
    });
    const select = screen.getByRole('combobox', { name: 'Show On Card' });
    expect(select.value).toBe('image:f0');
    expect(select.selectedOptions[0].textContent).toBe('site.jpg');
  });

  it('is locked for someone who cannot edit', async () => {
    await act(async () => {
      render(<ShowOnCardSelect task={{ id: 't1', attachmentIds: [], cardPreviewMode: 'checklist' }} onChange={() => {}} disabled />);
    });
    const select = screen.getByRole('combobox', { name: 'Show On Card' });
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('checklist');
  });
});

describe('on a phone', () => {
  it('the filter sheet carries Group (the lanes) and Columns for the Board, and the cover fits the card', async () => {
    window.matchMedia = (q) => ({
      matches: q.includes('max-width: 640px'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
    window.scrollTo = vi.fn();
    const tasks = [{ ...base, id: 't1', title: 'Photo Card', assigneeIds: ['a@x.com'], cardPreview: { kind: 'image', id: 'f1', name: 'site.jpg', url: 'http://localhost:8000/files/view?u=x' } }];
    store = makeStore(tasks);
    __setTablePrefsCache({ projectViews: { data: { p1: { view: 'board' } } } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    const img = screen.getByTestId('card-preview-image');
    expect(img.style.width).toBe('100%');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Filters & sort' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Columns/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Due Date' })); });
    expect(document.querySelector('[data-board-column="today"]')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Group/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Assignee' })); });
    expect(lanesShown()).toEqual(['a@x.com']);
  });
});

describe('Make Default View on Board', () => {
  it('keeps the List grouping as `group` and adds the lanes and columns', async () => {
    const tasks = [{ ...base, id: 't1', title: 'One', tags: ['Field'] }];
    store = makeStore(tasks, { role: 'owner' });
    store.projects[0].ownerId = ME;
    __setTablePrefsCache({ projectViews: { data: { p1: { view: 'board', group: 'priority', board: { lanes: 'label', columns: 'due' } } } } });
    render(<TasksWorkspace lockedProjectId="p1" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Make Default View/ })); });
    expect(store.updateProject).toHaveBeenCalledWith('p1', { defaultView: { view: 'board', group: 'priority', lanes: 'label', columns: 'due' } });
  });
});

describe('off a project, the Board layout comes back from the profile', () => {
  it('lanes, columns and Show Subtasks survive a fresh load of the saved settings', async () => {
    const tasks = [
      { ...base, id: 't1', title: 'Parent', projectId: '', assigneeIds: ['a@x.com'], priority: 'high', subtaskIds: ['k1'] },
      { ...base, id: 'k1', title: 'Kid', projectId: '', parentTaskId: 't1', assigneeIds: ['a@x.com'], priority: 'low' },
    ];
    store = makeStore(tasks);
    serverPrefs = { richlist: { view: 'board', board: { lanes: 'assignee', columns: 'priority', previews: false }, showSubtasks: { board: true } } };
    try { localStorage.clear(); } catch { /* none */ }
    __setTablePrefsCache(null);     // nothing cached: the page asks the server, as on a reload
    await act(async () => { render(<TasksWorkspace />); });
    expect(lanesShown()).toEqual(['a@x.com']);
    const cols = [...document.querySelectorAll('[data-board-lane="a@x.com"] [data-board-zone]')].map((el) => el.getAttribute('data-board-zone'));
    expect(cols).toEqual(['urgent', 'high', 'medium', 'low']);
    expect(screen.getByRole('button', { name: /Show Subtasks/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Card Previews/ }).getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-subtask-card="k1"]')).toBeTruthy();
  });
});

describe('Move To on Priority columns', () => {
  it('sets the priority from the keyboard', async () => {
    const tasks = [{ ...base, id: 't1', title: 'Pick Me', priority: 'low' }];
    store = boardStore(tasks);
    render(<BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" group="none" columns="priority" />);
    fireEvent.click(screen.getByLabelText('Move Pick Me to another column'));
    const menu = await screen.findByRole('menu', { name: 'Move To' });
    const items = within(within(menu).getByRole('group', { name: 'Priority' })).getAllByRole('menuitem');
    expect(items.find((b) => b.textContent.includes('Low')).disabled).toBe(true);
    await act(async () => { fireEvent.click(items.find((b) => b.textContent.includes('Urgent'))); });
    expect(store.updateTask).toHaveBeenCalledWith('t1', { priority: 'urgent' });
  });
});
