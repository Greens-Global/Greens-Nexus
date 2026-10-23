import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

// Labels done right (Oct 22 2026) - the screens: the labels box (reuse
// before create, keyboard, read-only), the pill, the Labels filter, the
// List grouped by label, and the batch bar's Add / Remove Label.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
let state;
vi.mock('./TasksContext', () => ({ useTasks: () => state }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => true }),
}));

const { __setLabelColors, LabelPill } = await import('./labels');
const { default: LabelsEditor } = await import('./LabelsEditor');
const { default: RichListView } = await import('./views/richlist');
const { BulkLabelPanel } = await import('./BulkActionBar');
const { MobileFilters } = await import('./productivity');
const { __setTablePrefsCache } = await import('./tableCols');

const mk = (id, tags) => ({
  id, title: `Task ${id}`, status: 'not_started', priority: 'medium', assigneeId: '', assigneeIds: [], teamId: '',
  projectId: '', dueOn: '', startOn: '', estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [],
  attachmentIds: [], tags, completed: false, code: `T-${id}`, customFieldValues: {},
});

beforeEach(() => {
  __setLabelColors({
    map: { urgent: { name: 'Urgent', color: 'teal' } },
    inUse: [{ key: 'urgent', name: 'Urgent', count: 3 }, { key: 'client', name: 'Client', count: 1 }],
  });
  __setTablePrefsCache({});
});

function Editor({ start = [], readOnly = false, onChange }) {
  const [tags, setTags] = useState(start);
  return <LabelsEditor tags={tags} readOnly={readOnly} onChange={(n) => { setTags(n); onChange?.(n); }} />;
}

describe('LabelPill', () => {
  it('wears its tone through the theme tokens and shows the company spelling', () => {
    render(<LabelPill name="URGENT" />);
    const pill = screen.getByText('Urgent').closest('.nx-tag');
    expect(pill).toHaveAttribute('data-tone', 'teal');
    expect(pill.style.color).toBe('var(--nx-tag-teal-fg)');
    expect(pill.style.background).toBe('var(--nx-tag-teal-bg)');
    expect(pill.style.border).toContain('var(--nx-tag-teal-border)');
  });

  it('offers a named remove button only when it can be removed', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<LabelPill name="Client" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<LabelPill name="Client" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove label Client' }));
    expect(onRemove).toHaveBeenCalledWith('Client');
  });
});

describe('the labels box', () => {
  it('reuses the existing spelling: "urgent" + Enter adds "Urgent"', () => {
    const onChange = vi.fn();
    render(<Editor start={['Client']} onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Add label' });
    fireEvent.change(box, { target: { value: 'urgent' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['Client', 'Urgent']);
  });

  it('comma adds what was typed; a label already there is not added again', () => {
    const onChange = vi.fn();
    render(<Editor start={['Client']} onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Add label' });
    fireEvent.change(box, { target: { value: 'brand new' } });
    fireEvent.keyDown(box, { key: ',' });
    expect(onChange).toHaveBeenLastCalledWith(['Client', 'brand new']);
    fireEvent.change(box, { target: { value: 'CLIENT' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('suggests labels in use and takes the highlighted one', () => {
    const onChange = vi.fn();
    render(<Editor start={['Client']} onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Add label' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'ur' } });
    const list = screen.getByRole('listbox', { name: 'Labels in use' });
    // Client is on the task already, so only Urgent is offered.
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['Client', 'Urgent']);
  });

  it('Backspace in an empty box removes the last label', () => {
    const onChange = vi.fn();
    render(<Editor start={['Client', 'Urgent']} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Add label' }), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(['Client']);
  });

  it('read-only shows the pills and nothing to change them with', () => {
    render(<Editor start={['Client']} readOnly />);
    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

const listStore = (tasks, extra = {}) => ({
  tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), customFields: [], customStatuses: [], projects: [],
  teams: [], loading: false, statusOrder: ['not_started'], statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } },
  projectName: () => '', teamById: () => null, teamName: () => '', setStatus: () => {}, toggleComplete: () => {},
  updateTask: vi.fn(() => Promise.resolve({})), createTask: vi.fn(() => Promise.resolve({})), ...extra,
});

function GroupedList({ tasks, store, onSelected }) {
  const [selected, setSelected] = useState(new Set());
  onSelected?.(selected);
  return (
    <RichListView visible={tasks} group="label" ctx={{ nameOf: () => '', projectName: () => '', teamName: () => '', customFields: [] }}
      store={store} people={[]} selected={selected} setSelected={setSelected} toggleSel={() => {}} onOpen={() => {}}
      onSelectAll={() => {}} lockedProjectId="" hidden={new Set()} setHidden={() => {}} />
  );
}

describe('the List grouped by label', () => {
  const tasks = [mk('a', ['Urgent', 'Client']), mk('b', ['urgent']), mk('c', [])];

  it('lists a task under each label, with pill headers and No Label last', () => {
    render(<GroupedList tasks={tasks} store={listStore(tasks)} />);
    expect(screen.getAllByText('Task a')).toHaveLength(2);
    expect(screen.getAllByText('Task b')).toHaveLength(1);
    const heads = screen.getAllByRole('button', { name: /^Select all in / }).map((b) => b.getAttribute('aria-label'));
    expect(heads).toEqual(['Select all in Client', 'Select all in Urgent', 'Select all in No Label']);
  });

  it("selecting two groups that share a task counts it once", () => {
    let current = new Set();
    render(<GroupedList tasks={tasks} store={listStore(tasks)} onSelected={(s) => { current = s; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all in Urgent' }));
    expect([...current].sort()).toEqual(['a', 'b']);
    // Client's one task is already picked through Urgent: that group reads
    // as fully selected, and the selection still holds two tasks.
    expect(screen.getByRole('button', { name: 'Deselect all in Client' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all in No Label' }));
    expect([...current].sort()).toEqual(['a', 'b', 'c']);
  });

  it('an inline add under a label group creates the task with that label', async () => {
    const store = listStore(tasks);
    render(<GroupedList tasks={tasks} store={store} />);
    const adds = screen.getAllByPlaceholderText('Add task…');
    // Groups in order: Client, Urgent, No Label.
    fireEvent.change(adds[1], { target: { value: 'Call the vendor' } });
    await act(async () => { fireEvent.keyDown(adds[1], { key: 'Enter' }); });
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call the vendor', tags: ['Urgent'] }));
    fireEvent.change(adds[2], { target: { value: 'Unlabeled' } });
    await act(async () => { fireEvent.keyDown(adds[2], { key: 'Enter' }); });
    expect(store.createTask.mock.calls[1][0].tags).toBeUndefined();
  });

  const dt = () => ({ effectAllowed: '', dropEffect: '', setData() {}, getData() { return ''; } });
  const groupBlock = (name) => screen.getByRole('button', { name: new RegExp(`^(Select|Deselect) all in ${name}$`) })
    .closest('[style*="margin-top: 22px"]');

  it('dragging a row to another label group moves the label', () => {
    const store = listStore(tasks);
    render(<GroupedList tasks={tasks} store={store} />);
    // Task b is only under Urgent; dropped on Client it trades Urgent for Client.
    const row = screen.getByText('Task b').closest('[data-task-row]');
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.dragOver(groupBlock('Client'), { dataTransfer: dt() });
    fireEvent.drop(groupBlock('Client'), { dataTransfer: dt() });
    expect(store.updateTask).toHaveBeenLastCalledWith('b', { tags: ['Client'] });
  });

  it('a drag within its own label group only reorders, and No Label just takes the label off', () => {
    const store = listStore(tasks);
    render(<GroupedList tasks={tasks} store={store} />);
    const row = screen.getByText('Task b').closest('[data-task-row]');
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.drop(groupBlock('Urgent'), { dataTransfer: dt() });
    expect(store.updateTask).not.toHaveBeenCalled();
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.drop(groupBlock('No Label'), { dataTransfer: dt() });
    expect(store.updateTask).toHaveBeenLastCalledWith('b', { tags: [] });
  });

  it('a task listed twice shows the drop line only on the copy under the cursor', () => {
    render(<GroupedList tasks={tasks} store={listStore(tasks)} />);
    fireEvent.dragStart(screen.getByText('Task b').closest('[data-task-row]'), { dataTransfer: dt() });
    const copies = screen.getAllByText('Task a').map((el) => el.closest('[data-task-row]'));
    expect(copies).toHaveLength(2);
    fireEvent.dragOver(copies[1], { dataTransfer: dt(), clientY: 0 });
    const lines = copies.map((el) => /inset/.test(el.style.boxShadow));
    expect(lines).toEqual([false, true]);
  });

  it('shows each row its labels', () => {
    render(<GroupedList tasks={[tasks[0]]} store={listStore([tasks[0]])} />);
    const strips = document.querySelectorAll('[data-labels]');
    expect(strips.length).toBeGreaterThan(0);
    expect(strips[0].getAttribute('title')).toBe('Labels: Urgent, Client');
  });
});

describe('the batch bar label picker', () => {
  const tasks = [mk('a', ['Urgent', 'Client']), mk('b', ['urgent']), mk('c', [])];
  const selected = new Set(['a', 'b']);

  it('adds an existing label in its own spelling, or creates a new one', () => {
    const onApply = vi.fn();
    render(<BulkLabelPanel mode="add" tasks={tasks} selected={selected} onApply={onApply} />);
    const box = screen.getByRole('textbox', { name: 'Label name' });
    fireEvent.change(box, { target: { value: 'URGENT' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onApply).toHaveBeenLastCalledWith('Urgent');
    fireEvent.change(box, { target: { value: 'Q4 Close' } });
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onApply).toHaveBeenLastCalledWith('Q4 Close');
  });

  it('removes from the labels the selected tasks carry, with how many carry each', () => {
    const onApply = vi.fn();
    render(<BulkLabelPanel mode="remove" tasks={tasks} selected={selected} onApply={onApply} />);
    expect(screen.getByText('2 of 2')).toBeInTheDocument();   // Urgent, either spelling
    expect(screen.getByText('1 of 2')).toBeInTheDocument();   // Client
    fireEvent.click(screen.getByText('1 of 2').closest('button'));
    expect(onApply).toHaveBeenCalledWith('Client');
  });
});

describe('the Labels filter', () => {
  it('lists the labels in use and picks them by key', () => {
    state = { tasks: [mk('a', ['Urgent'])], savedViews: [], projects: [], teams: [], statusOrder: ['not_started'],
      statusMeta: { not_started: { label: 'Not Started', color: '#888', tint: '#eee' } }, createSavedView: vi.fn(), deleteSavedView: vi.fn() };
    const setFilters = vi.fn();
    const filters = { assigneeIds: [], collaboratorIds: [], statuses: [], priorities: [], teamIds: [], projectIds: [], tags: [], due: 'any', customFields: {} };
    render(<MobileFilters filters={filters} setFilters={setFilters} sort={{ key: 'manual', dir: 'asc' }} setSort={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    // "Urgent" is a priority too; the label is the one in a checkbox row.
    const urgent = screen.getAllByText('Urgent').map((el) => el.closest('label')).find(Boolean);
    fireEvent.click(within(urgent).getByRole('checkbox'));
    expect(setFilters).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['urgent'] }));
    expect(screen.getByText('Client')).toBeInTheDocument();
  });
});
