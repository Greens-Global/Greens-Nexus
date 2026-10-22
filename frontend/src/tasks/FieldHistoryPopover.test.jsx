import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Field history in the task drawer (Oct 22 2026): a clock beside a field opens
// who changed it, when (MM/DD/YYYY h:mm AM/PM) and From -> To in readable
// words - for a viewer as much as an editor. The Activity tab folds a save's
// field rows into one line and has a Field Changes filter.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const apiOverride = vi.hoisted(() => ({}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => apiOverride[k] || (() => Promise.resolve([])) }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }),
}));

const ME = 'me@x.com';
const project = { id: 'p1', name: 'Plant', ownerId: 'boss@x.com', accessLevel: 'restricted', memberIds: [ME], memberRoles: { [ME]: 'viewer' } };
const task = {
  id: 't1', title: 'Fix the pump', status: 'in_progress', priority: 'high', projectId: 'p1', parentTaskId: '',
  assigneeIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], followerIds: [], tags: [],
  customFieldValues: {}, completed: false, description: '',
};
const NAMES = { 'sam@x.com': 'Sam Lee', [ME]: 'Me Myself' };
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
const store = () => ({
  tasks: [task], taskById: { t1: task }, teams: [], projects: [project], customFields: [],
  statusMeta: {
    not_started: { label: 'Not Started', color: '#888' }, in_progress: { label: 'In Progress', color: '#fdab3d' },
  },
  statusOrder: ['not_started', 'in_progress'], statusOrderFor: () => ['not_started', 'in_progress'],
  loading: false, runningTimer: null, projectName: (id) => (id === 'p1' ? 'Plant' : ''), teamName: () => '',
  nameOf: (e) => NAMES[e] || e, myEmail: ME,
  updateTask: vi.fn(() => Promise.resolve({})), deleteTask: vi.fn(), createTask: vi.fn(() => Promise.resolve({})),
  getComments: vi.fn(() => Promise.resolve([])), addComment: vi.fn(), offerUndo: vi.fn(),
  toggleComplete: vi.fn(() => Promise.resolve()), refresh: vi.fn(), applyServerTask: vi.fn(),
  startTimer: vi.fn(), stopTimer: vi.fn(),
});

const { default: TaskDetailDrawer, ActivityTab } = await import('./TaskDetailDrawer');
const { FieldHistoryButton } = await import('./FieldHistoryPopover');
const { FieldHistoryContext } = await import('./fieldHistoryContext');

beforeEach(() => {
  for (const k of Object.keys(apiOverride)) delete apiOverride[k];
  state = store();
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const statusItems = [
  { id: 'h2', at: '2026-10-22T18:30:00Z', actorId: 'sam@x.com', type: 'status_changed', field: 'status', fieldId: null,
    label: 'Status', from: 'gone', to: 'in_progress', labels: { gone: { label: 'Waiting', color: '#abcdef' } } },
  { id: 'h1', at: '2026-10-21T15:05:00Z', actorId: ME, type: 'status_changed', field: 'status', fieldId: null,
    label: 'Status', from: 'not_started', to: 'gone', labels: {} },
];

describe('the field history popover', () => {
  it('lists who, when and From -> To for one field', async () => {
    apiOverride.getTaskHistory = vi.fn(() => Promise.resolve({ items: statusItems, more: false }));
    render(
      <FieldHistoryContext.Provider value={{ taskId: 't1', nameOf: state.nameOf }}>
        <FieldHistoryButton field="status" label="Status" />
      </FieldHistoryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Status History' }));
    const list = await screen.findByTestId('field-history-list');
    expect(apiOverride.getTaskHistory).toHaveBeenCalledWith('t1', { field: 'status', limit: 20 });
    expect(within(list).getByText('Sam Lee')).toBeTruthy();
    expect(within(list).getByText('Me Myself')).toBeTruthy();
    // The stored label of a since-deleted status (or Removed Status when none
    // was kept), the live label of a current one.
    expect(within(list).getByText('Waiting')).toBeTruthy();
    expect(within(list).getByText('Removed Status')).toBeTruthy();
    expect(within(list).getByText('In Progress')).toBeTruthy();
    expect(within(list).getByText('Not Started')).toBeTruthy();
    expect(list.textContent).toMatch(/10\/22\/2026, \d{1,2}:\d{2} (AM|PM)/);
    expect(list.textContent).not.toMatch(/2026-10-22/);
  });

  it('says so when nothing was recorded, and pages with Show More', async () => {
    apiOverride.getTaskHistory = vi.fn()
      .mockResolvedValueOnce({ items: [statusItems[0]], more: true })
      .mockResolvedValueOnce({ items: [statusItems[1]], more: false });
    render(
      <FieldHistoryContext.Provider value={{ taskId: 't1', nameOf: state.nameOf }}>
        <FieldHistoryButton field="status" label="Status" />
      </FieldHistoryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Status History' }));
    fireEvent.click(await screen.findByText('Show More'));
    await waitFor(() => expect(screen.getByText('Me Myself')).toBeTruthy());
    expect(apiOverride.getTaskHistory).toHaveBeenLastCalledWith('t1', { field: 'status', limit: 20, offset: 1 });
    expect(screen.queryByText('Show More')).toBeNull();
  });

  it('shows an empty state', async () => {
    apiOverride.getTaskHistory = vi.fn(() => Promise.resolve({ items: [], more: false }));
    render(
      <FieldHistoryContext.Provider value={{ taskId: 't1', nameOf: state.nameOf }}>
        <FieldHistoryButton field="dueOn" label="Due Date" />
      </FieldHistoryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Due Date History' }));
    expect(await screen.findByText('No changes recorded yet.')).toBeTruthy();
  });

  it('renders nothing outside a task drawer', () => {
    const { container } = render(<FieldHistoryButton field="status" label="Status" />);
    expect(container.innerHTML).toBe('');
  });

  it('a viewer opens it from the read-only drawer', async () => {
    apiOverride.getTaskHistory = vi.fn(() => Promise.resolve({ items: statusItems, more: false }));
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />);
    expect(screen.getByTestId('view-only-note')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Priority History' }));
    await screen.findByTestId('field-history-list');
    expect(apiOverride.getTaskHistory).toHaveBeenCalledWith('t1', { field: 'priority', limit: 20 });
    // The title has one too.
    expect(screen.getByRole('button', { name: 'Title History' })).toBeTruthy();
  });
});

describe('the Activity tab', () => {
  const at = (s) => `2026-10-22T15:00:${String(s).padStart(2, '0')}Z`;
  const rows = [   // newest first, as GET /tasks/{id}/activity answers
    { id: 'a1', at: at(30), type: 'field_changed', actorId: 'sam@x.com', entityId: 't1', detail: 'changed Priority',
      change: { field: 'priority', from: 'medium', to: 'high' } },
    { id: 'a2', at: at(30), type: 'field_changed', actorId: 'sam@x.com', entityId: 't1', detail: 'changed Start Date',
      change: { field: 'startOn', from: null, to: '2026-10-20' } },
    { id: 'a3', at: at(10), type: 'commented', actorId: ME, entityId: 't1', detail: 'commented', change: null },
  ];

  it('folds a save into one line, and Field Changes lists each with From -> To', async () => {
    apiOverride.getTaskActivity = vi.fn(() => Promise.resolve(rows));
    render(<ActivityTab taskId="t1" nameOf={state.nameOf} />);
    expect(await screen.findByText('changed Priority and Start Date')).toBeTruthy();
    expect(screen.getByText('commented')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Field Changes' }));
    expect(screen.queryByText('commented')).toBeNull();
    expect(screen.getByText('changed Priority')).toBeTruthy();
    expect(screen.getByText('changed Start Date')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('10/20/2026')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
  });
});
