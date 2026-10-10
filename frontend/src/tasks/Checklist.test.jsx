import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The checklist inside a task (Oct 2026): loads its lines, adds one or a
// pasted list, ticks, and hands the returned task back to the store so the
// list rows' counters move.

const calls = { add: vi.fn(), update: vi.fn(), del: vi.fn(), order: vi.fn() };
let serverItems = [];
vi.mock('../api', () => ({
  api: {
    getTaskChecklist: () => Promise.resolve(serverItems),
    addTaskChecklistItems: (...a) => calls.add(...a),
    updateTaskChecklistItem: (...a) => calls.update(...a),
    deleteTaskChecklistItem: (...a) => calls.del(...a),
    reorderTaskChecklist: (...a) => calls.order(...a),
    getPeopleDirectory: () => Promise.resolve([]),
    getPersonPhotos: () => Promise.resolve({}),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
const applyServerTask = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    applyServerTask,
    myEmail: 'reader@greensglobal.com',
    nameOf: (e) => ({ 'reader@greensglobal.com': 'Rita Reader' }[e] || e),
  }),
}));

const Checklist = (await import('./Checklist')).default;
const { itemsFromPaste } = await import('./lib');

const task = { id: 't1', checklistTotal: 0, checklistDone: 0 };

describe('Checklist', () => {
  beforeEach(() => {
    serverItems = [];
    Object.values(calls).forEach((f) => f.mockReset());
    applyServerTask.mockReset();
  });

  it('adds a line on Enter and hands the task back to the store', async () => {
    calls.add.mockResolvedValue({ items: [{ id: 'i1', title: 'Call the vendor', done: false }], task: { id: 't1', checklistTotal: 1, checklistDone: 0 } });
    render(<Checklist task={task} />);
    const box = await screen.findByLabelText('Add checklist item');
    fireEvent.change(box, { target: { value: 'Call the vendor' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('Call the vendor');
    expect(calls.add).toHaveBeenCalledWith('t1', { title: 'Call the vendor' });
    expect(applyServerTask).toHaveBeenCalledWith(expect.objectContaining({ checklistTotal: 1 }));
    expect(box.value).toBe('');
  });

  it('pastes a list as several lines in one request', async () => {
    calls.add.mockResolvedValue({ items: [{ id: 'a', title: 'One', done: false }, { id: 'b', title: 'Two', done: false }], task });
    render(<Checklist task={task} />);
    const box = await screen.findByLabelText('Add checklist item');
    fireEvent.paste(box, { clipboardData: { getData: () => '- One\n- Two\n' } });
    await screen.findByText('Two');
    expect(calls.add).toHaveBeenCalledWith('t1', { title: '', titles: ['One', 'Two'] });
  });

  it('ticks a line optimistically and shows progress', async () => {
    serverItems = [{ id: 'i1', title: 'Step', done: false }, { id: 'i2', title: 'Other', done: true }];
    calls.update.mockResolvedValue({ item: { id: 'i1', title: 'Step', done: true, doneBy: 'reader@greensglobal.com' }, task: { id: 't1', checklistTotal: 2, checklistDone: 2 } });
    render(<Checklist task={task} />);
    await screen.findByText('Step');
    expect(screen.getByText('1/2')).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Mark done')[0]);
    await waitFor(() => expect(calls.update).toHaveBeenCalledWith('i1', { done: true }));
    await screen.findByText('2/2');
    expect(applyServerTask).toHaveBeenCalledWith(expect.objectContaining({ checklistDone: 2 }));
  });

  it('a reader only ticks the line that names them', async () => {
    serverItems = [{ id: 'mine', title: 'Mine', done: false, assigneeId: 'reader@greensglobal.com' }, { id: 'theirs', title: 'Theirs', done: false }];
    render(<Checklist task={task} canEdit={false} />);
    await screen.findByText('Mine');
    const ticks = screen.getAllByLabelText('Mark done');
    expect(ticks[0]).not.toBeDisabled();
    expect(ticks[1]).toBeDisabled();
    expect(screen.queryByLabelText('Add checklist item')).toBeNull();
  });

  it('reverts a tick the server refused', async () => {
    serverItems = [{ id: 'i1', title: 'Step', done: false }];
    calls.update.mockRejectedValue(new Error('403'));
    render(<Checklist task={task} />);
    await screen.findByText('Step');
    fireEvent.click(screen.getByLabelText('Mark done'));
    await screen.findByText('403');
    expect(screen.getByLabelText('Mark done')).toBeInTheDocument();
  });
});

describe('itemsFromPaste', () => {
  it('splits bullets, numbers and boxes; leaves a single line alone', () => {
    expect(itemsFromPaste('1. First\n2) Second\n[ ] Third\n• Fourth\n\n')).toEqual(['First', 'Second', 'Third', 'Fourth']);
    expect(itemsFromPaste('just one line')).toBeNull();
  });
});
