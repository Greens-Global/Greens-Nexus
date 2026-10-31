import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

// Tasks > My Day (Oct 22 2026): the list for today, its composition from the
// server's answer and the live task store, optimistic changes that go back
// on a refusal, the midnight reset, the phone layout and the drawer's sun.

const ME = 'me@x.com';
const apiOverride = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => apiOverride[k] || (() => Promise.resolve([])) }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }),
}));
let mobile = false;
vi.mock('./components', async (orig) => {
  const real = await orig();
  return { ...real, useIsMobile: () => mobile };
});
vi.mock('../components/AnchoredMenu', () => ({ default: ({ open, children }) => (open ? <div>{children}</div> : null) }));
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
vi.mock('./AddSeveralModal', () => ({ default: ({ defaults, onDone, onClose }) => (
  <div data-testid="add-several" data-defaults={JSON.stringify(defaults)}>
    <button type="button" onClick={() => { onDone?.({ created: 2, topLevelIds: ['a'] }); onClose?.(true); }}>Finish Several</button>
  </div>
) }));

const lib = await import('./lib');
const M = await import('./myDay');
const { default: MyDayView } = await import('./MyDayView');
const { default: MyDayToggle } = await import('./MyDayToggle');

const task = (id, extra = {}) => ({
  id, title: `Task ${id}`, status: 'not_started', priority: 'medium', projectId: '', parentTaskId: '',
  assigneeIds: [ME], subtaskIds: [], followerIds: [], tags: [], completed: false, dueOn: '', ...extra,
});

function makeStore(tasks = []) {
  return {
    tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: [], teams: [], myEmail: ME,
    projectName: () => '', projectById: {}, nameOf: (e) => e, statusMeta: {},
    notify: vi.fn(), offerUndo: vi.fn(), toggleComplete: vi.fn(() => Promise.resolve()),
    createTask: vi.fn((d) => Promise.resolve({ ...task('new'), ...d, id: 'new' })),
  };
}

const payload = (day, { tasks = [], addedIds = [], dismissedIds = [], suggestions = [] } = {}) => ({
  day, tasks, addedIds, dismissedIds,
  suggestions: M.SUGGESTION_GROUPS.map((g) => ({ key: g.key, tasks: suggestions.filter((s) => s.group === g.key).map((s) => s.task) })),
});

beforeEach(() => {
  M.resetMyDay();
  mobile = false;
  for (const k of Object.keys(apiOverride)) delete apiOverride[k];
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('labels', () => {
  it('reads the date as weekday plus MM/DD/YYYY, and progress as "3 of 7 done"', () => {
    expect(M.myDayDateLabel('2026-10-22')).toBe('Thursday, 10/22/2026');
    expect(M.myDayDateLabel('2026-01-04')).toBe('Sunday, 01/04/2026');
    expect(M.progressLabel(3, 7)).toBe('3 of 7 done');
  });
});

describe('composeMyDay', () => {
  const day = '2026-10-22';
  const base = { ...M.myDaySnapshot(), status: 'ready', day, email: ME };
  it('picks in my order, then due-today tasks, finished ones last', () => {
    const a = task('a'); const b = task('b', { completed: true }); const auto = task('auto', { dueOn: day });
    const s = { ...base, addedIds: ['b', 'a'], serverOrder: ['b', 'a', 'auto'], serverTasks: { a, b, auto } };
    const out = M.composeMyDay(s, { tasks: [], taskById: {}, me: ME });
    expect(out.rows.map((t) => t.id)).toEqual(['a', 'auto', 'b']);
    expect(out.done.map((t) => t.id)).toEqual(['b']);
  });
  it('follows the live store: a due date moved away leaves, a new due-today task joins, a dismissed one stays off', () => {
    const moved = task('moved', { dueOn: day });
    const s = { ...base, serverOrder: ['moved'], serverTasks: { moved }, dismissedIds: ['off'] };
    const live = [task('moved', { dueOn: '2026-10-23' }), task('joins', { dueOn: day }), task('off', { dueOn: day }),
      task('theirs', { dueOn: day, assigneeIds: ['other@x.com'] })];
    const out = M.composeMyDay(s, { tasks: live, taskById: Object.fromEntries(live.map((t) => [t.id, t])), me: ME });
    expect(out.rows.map((t) => t.id)).toEqual(['joins']);
  });
  it('sorts by orderIds without making anything a pick, and a reordered due-today task still leaves', () => {
    const a = task('a'); const auto = task('auto', { dueOn: day }); const other = task('other', { dueOn: day });
    const s = { ...base, addedIds: ['a'], orderIds: ['other', 'auto', 'a'], serverOrder: ['a', 'auto', 'other'],
      serverTasks: { a, auto, other } };
    expect(M.composeMyDay(s, { me: ME }).rows.map((t) => t.id)).toEqual(['other', 'auto', 'a']);
    const reassigned = { ...auto, assigneeIds: ['x@x.com'] };
    const out = M.composeMyDay(s, { tasks: [reassigned, other, a], taskById: { auto: reassigned, other, a }, me: ME });
    expect(out.rows.map((t) => t.id)).toEqual(['other', 'a']);
  });
  it('moveId clamps at the ends', () => {
    expect(M.moveId(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    const same = ['a', 'b'];
    expect(M.moveId(same, 'a', -1)).toBe(same);
  });
});

describe('My Day tab', () => {
  it('shows the header, the progress and the rows, finished ones struck through at the bottom', async () => {
    const day = lib.todayISO();
    const rows = [task('a', { title: 'Write report', dueOn: day }), task('b', { title: 'Call vendor', completed: true }),
      task('c', { title: 'Old thing', dueOn: lib.addDays(day, -2), priority: 'high' })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['b', 'c'] })));
    render(<MyDayView onOpen={() => {}} />);
    expect(screen.getByRole('heading', { name: 'My Day' })).toBeTruthy();
    expect(screen.getByTestId('myday-date').textContent).toBe(M.myDayDateLabel(day));
    await screen.findByText('Write report');
    expect(apiOverride.getMyDay).toHaveBeenCalledWith(day);
    expect(screen.getByTestId('myday-progress').textContent).toBe('1 of 3 done');
    const names = screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Old thing', 'Write report', 'Call vendor']);
    expect(screen.getByText('Call vendor').style.textDecoration).toBe('line-through');
    expect(screen.getByText(/^Overdue · /)).toBeTruthy();
  });

  it('says so when nothing is planned, and points at Suggestions', async () => {
    state = makeStore([]);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(lib.todayISO())));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Nothing planned for today yet.');
    fireEvent.click(screen.getByRole('button', { name: /Open Suggestions/ }));
    expect(screen.getByRole('complementary', { name: 'Suggestions' })).toBeTruthy();
  });

  it('adds a suggestion at once and puts it back with a notice when the server refuses', async () => {
    const day = lib.todayISO();
    const late = task('late', { title: 'Late one', dueOn: lib.addDays(day, -3) });
    state = makeStore([late]);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { suggestions: [{ group: 'overdue', task: late }] })));
    let refuse;
    apiOverride.addToMyDay = vi.fn(() => new Promise((_, rej) => { refuse = rej; }));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Nothing planned for today yet.');
    fireEvent.click(screen.getByRole('button', { name: /^Suggestions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Late one to My Day' }));
    // Optimistic: on the list before the server answers, gone from Suggestions.
    expect(screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))).toEqual(['Late one']);
    expect(screen.queryByRole('button', { name: 'Add Late one to My Day' })).toBeNull();
    await waitFor(() => expect(apiOverride.addToMyDay).toHaveBeenCalledWith(day, 'late', true));
    await act(async () => { refuse(Object.assign(new Error('nope'), { status: 500 })); });
    await screen.findByText('Nothing planned for today yet.');
    expect(screen.getByRole('button', { name: 'Add Late one to My Day' })).toBeTruthy();
    expect(state.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not add that to My Day/));
  });

  it('quick add creates a task for me, due today, with no project, and puts it on top', async () => {
    const day = lib.todayISO();
    state = makeStore([]);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day)));
    apiOverride.addToMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: [task('new', { title: 'Buy toner', dueOn: day })], addedIds: ['new'] })));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Nothing planned for today yet.');
    const box = screen.getByLabelText('Add a task for today');
    fireEvent.change(box, { target: { value: 'Buy toner' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(state.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Buy toner', assigneeIds: [ME], projectId: '', dueOn: day,
    }));
    expect(apiOverride.addToMyDay).toHaveBeenCalledWith(day, 'new', true);
    await screen.findByText('Buy toner');
    expect(box.value).toBe('');
  });

  it('a reorder changes the order only, never the picks', async () => {
    const day = lib.todayISO();
    const rows = [task('a', { title: 'Pick' }), task('auto', { title: 'Due today', dueOn: day })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a'] })));
    apiOverride.reorderMyDay = vi.fn(() => new Promise(() => {}));
    render(<MyDayView onOpen={() => {}} />);
    const first = (await screen.findByText('Pick')).closest('[data-myday-row]');
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    expect(M.myDaySnapshot().addedIds).toEqual(['a']);
    expect(M.myDaySnapshot().orderIds).toEqual(['auto', 'a']);
    expect(screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))).toEqual(['Due today', 'Pick']);
  });

  it('Undo of a removal puts it back as what it was, where it was', async () => {
    const day = lib.todayISO();
    const rows = [task('a', { title: 'Pick' }), task('auto', { title: 'Due today', dueOn: day })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a'] })));
    apiOverride.removeFromMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: [rows[0]], addedIds: ['a'], dismissedIds: ['auto'] })));
    apiOverride.addToMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a'] })));
    apiOverride.reorderMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a'] })));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Due today');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Due today from My Day' })); });
    const undo = state.offerUndo.mock.calls.at(-1)[1];
    await act(async () => { undo(); });
    expect(apiOverride.addToMyDay).toHaveBeenCalledWith(day, 'auto', false);   // a due-today task, not a pick
    await waitFor(() => expect(apiOverride.reorderMyDay).toHaveBeenCalledWith(day, ['a', 'auto']));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Pick from My Day' })); });
    await act(async () => { state.offerUndo.mock.calls.at(-1)[1](); });
    expect(apiOverride.addToMyDay).toHaveBeenLastCalledWith(day, 'a', true);
  });

  it('Alt+Down moves a row and saves the new order', async () => {
    const day = lib.todayISO();
    const rows = [task('a', { title: 'First' }), task('b', { title: 'Second' })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a', 'b'] })));
    apiOverride.reorderMyDay = vi.fn(() => new Promise(() => {}));
    render(<MyDayView onOpen={() => {}} />);
    const first = (await screen.findByText('First')).closest('[data-myday-row]');
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(apiOverride.reorderMyDay).toHaveBeenCalledWith(day, ['b', 'a']));
    expect(screen.getAllByRole('listitem').map((r) => r.getAttribute('aria-label'))).toEqual(['Second', 'First']);
  });

  it('resets at local midnight: the one-minute check loads the new day, empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 22, 23, 59, 30));
    const rows = [task('a', { title: 'Tonight' })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn((day) => Promise.resolve(day === '2026-10-22'
      ? payload(day, { tasks: rows, addedIds: ['a'] }) : payload(day)));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Tonight');
    expect(screen.getByTestId('myday-date').textContent).toBe('Thursday, 10/22/2026');
    await act(async () => { vi.setSystemTime(new Date(2026, 9, 23, 0, 0, 30)); vi.advanceTimersByTime(60 * 1000); });
    expect(apiOverride.getMyDay).toHaveBeenLastCalledWith('2026-10-23');
    await screen.findByText('Nothing planned for today yet.');
    expect(screen.getByTestId('myday-date').textContent).toBe('Friday, 10/23/2026');
    expect(screen.queryByText('Tonight')).toBeNull();
  });

  it('the minute check fetches nothing while the date stays the same', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 22, 10, 0, 0));
    state = makeStore([]);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload('2026-10-22')));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Nothing planned for today yet.');
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(apiOverride.getMyDay).toHaveBeenCalledTimes(1);
  });

  it('works on a phone: no drag handles, a menu per row, Suggestions as a sheet', async () => {
    mobile = true;
    const day = lib.todayISO();
    const rows = [task('a', { title: 'Phone one' }), task('b', { title: 'Phone two' })];
    state = makeStore(rows);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: rows, addedIds: ['a', 'b'] })));
    apiOverride.removeFromMyDay = vi.fn(() => new Promise(() => {}));
    render(<MyDayView onOpen={() => {}} />);
    await screen.findByText('Phone one');
    expect(screen.queryByTitle('Drag to reorder')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Phone one' }));
    expect(screen.queryByRole('menuitem', { name: /Move Up/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove From My Day/ }));
    await waitFor(() => expect(apiOverride.removeFromMyDay).toHaveBeenCalledWith(day, 'a'));
    expect(screen.queryByText('Phone one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Suggestions/ }));
    const sheet = screen.getByRole('dialog', { name: 'Suggestions' });
    expect(within(sheet).getByText(/No suggestions right now/)).toBeTruthy();
  });
});

describe('My Day add row paste', () => {
  it('a pasted list opens Add Several due the day shown, and says how many were added', async () => {
    state = makeStore([]);
    const day = lib.todayISO();
    apiOverride.getMyDay = () => Promise.resolve(payload(day));
    render(<MyDayView onOpen={() => {}} />);
    const box = await screen.findByLabelText('Add a task for today');
    fireEvent.paste(box, { clipboardData: { getData: () => 'One\nTwo' } });
    const modal = await screen.findByTestId('add-several');
    expect(JSON.parse(modal.dataset.defaults)).toMatchObject({ text: 'One\nTwo', dueOn: day, assigneeIds: [ME], source: 'paste' });
    expect(state.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Several' }));
    expect(screen.getByText('1 task added for today')).toBeTruthy();
  });
});

describe('the drawer sun', () => {
  it('adds and removes the task, and says which it will do', async () => {
    const day = lib.todayISO();
    const t = task('t1', { title: 'Drawer task', assigneeIds: ['other@x.com'] });
    state = makeStore([t]);
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(day)));
    apiOverride.addToMyDay = vi.fn(() => Promise.resolve(payload(day, { tasks: [t], addedIds: ['t1'] })));
    apiOverride.removeFromMyDay = vi.fn(() => Promise.resolve(payload(day, { dismissedIds: ['t1'] })));
    render(<MyDayToggle task={t} />);
    const sun = await screen.findByRole('button', { name: 'Add To My Day' });
    expect(sun.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(sun); });
    expect(apiOverride.addToMyDay).toHaveBeenCalledWith(day, 't1', true);
    const on = screen.getByRole('button', { name: 'Remove From My Day' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(on); });
    expect(apiOverride.removeFromMyDay).toHaveBeenCalledWith(day, 't1');
    expect(screen.getByRole('button', { name: 'Add To My Day' })).toBeTruthy();
    expect(state.offerUndo).toHaveBeenCalledWith(expect.stringMatching(/Removed "Drawer task" from My Day/), expect.any(Function));
  });

  it('follows the new day when the tab is looked at again after midnight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 22, 23, 50, 0));
    const t = task('t1', { title: 'Late night' });
    state = makeStore([t]);
    apiOverride.getMyDay = vi.fn((day) => Promise.resolve(day === '2026-10-22'
      ? payload(day, { tasks: [t], addedIds: ['t1'] }) : payload(day)));
    render(<MyDayToggle task={t} />);
    await screen.findByRole('button', { name: 'Remove From My Day' });
    await act(async () => { vi.setSystemTime(new Date(2026, 9, 23, 7, 0, 0)); window.dispatchEvent(new Event('focus')); });
    expect(apiOverride.getMyDay).toHaveBeenLastCalledWith('2026-10-23');
    await screen.findByRole('button', { name: 'Add To My Day' });
  });

  it('sits in the task drawer header', async () => {
    const t = task('t1', { title: 'In the drawer' });
    state = { ...makeStore([t]), customFields: [], statusOrder: ['not_started'], statusOrderFor: () => ['not_started'],
      teamName: () => '', loading: false, runningTimer: null, updateTask: vi.fn(() => Promise.resolve({})),
      deleteTask: vi.fn(), getComments: vi.fn(() => Promise.resolve([])), addComment: vi.fn(), refresh: vi.fn(),
      applyServerTask: vi.fn(), startTimer: vi.fn(), stopTimer: vi.fn() };
    apiOverride.getMyDay = vi.fn(() => Promise.resolve(payload(lib.todayISO(), { tasks: [t], addedIds: ['t1'] })));
    const { default: TaskDetailDrawer } = await import('./TaskDetailDrawer');
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('myday-toggle').getAttribute('aria-label')).toBe('Remove From My Day'));
  });
});

describe('phone bar on My Day', () => {
  it('has no filter button when the screen has nothing to filter', async () => {
    const { default: MobileTaskBar } = await import('./MobileTaskBar');
    const views = [{ key: 'myday', label: 'My Day', icon: () => null }];
    const { rerender } = render(<MobileTaskBar views={views} view="myday" setView={() => {}} onCreate={() => {}} filterSheet={null} />);
    expect(screen.queryByLabelText('Filters & sort')).toBeNull();
    rerender(<MobileTaskBar views={views} view="myday" setView={() => {}} onCreate={() => {}} filterSheet={() => null} />);
    expect(screen.getByLabelText('Filters & sort')).toBeTruthy();
  });
});
