// Create Task + Add Several (Oct 31 2026): a list pasted into the Title, or
// the Add Several button, hands the form's shared fields to AddSeveralModal;
// editing an existing task never opens it; the form closes once the list is
// added.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const createTask = vi.fn();
const editingTask = { id: 't9', title: 'Old task', assigneeIds: ['me@greensglobal.com'], followerIds: [], tags: [], customFieldValues: {}, status: 'not_started', priority: 'medium', projectId: '' };
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    createTask, updateTask: vi.fn(), deleteTask: vi.fn(), tasks: [editingTask], taskById: { t9: editingTask },
    projects: [{ id: 'p1', name: 'Launch Plan' }], teams: [], myEmail: 'me@greensglobal.com', customFields: [],
    statusMeta: { not_started: { label: 'Not Started' }, in_progress: { label: 'In Progress' } }, statusOrder: ['not_started', 'in_progress'],
  }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
vi.mock('./frequentPeople', async (orig) => ({ ...(await orig()), useFrequentCollaborators: () => [] }));
vi.mock('./RichDescription', () => ({ default: () => <div /> }));
vi.mock('./SayIt', () => ({ default: () => null }));
vi.mock('./AddSeveralModal', () => ({ default: ({ defaults, onClose }) => (
  <div data-testid="add-several" data-defaults={JSON.stringify(defaults)}>
    <button type="button" onClick={() => onClose?.(true)}>Finish Several</button>
  </div>
) }));

import CreateTaskModal from './CreateTaskModal';

afterEach(() => { cleanup(); createTask.mockReset(); });

describe('CreateTaskModal + Add Several', () => {
  it('a pasted list in the Title opens Add Several with the form\'s fields, and the form closes when it is added', async () => {
    const onClose = vi.fn();
    render(<CreateTaskModal onClose={onClose} defaults={{ projectId: 'p1', dueOn: '2026-11-05', tags: ['Q4'] }} lockedProjectId="p1" />);
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Typed' } });
    fireEvent.paste(title, { clipboardData: { getData: () => 'One\nTwo' } });
    const modal = await screen.findByTestId('add-several');
    expect(JSON.parse(modal.dataset.defaults)).toMatchObject({
      text: 'Typed\nOne\nTwo', source: 'paste', fromForm: true, projectId: 'p1', lockedProjectId: 'p1',
      assigneeIds: ['me@greensglobal.com'], dueOn: '2026-11-05', tags: ['Q4'], status: 'not_started', priority: 'medium',
    });
    expect(createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Several' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('the Add Several button opens it with the typed title as the first line', async () => {
    render(<CreateTaskModal onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First one' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Several/ }));
    const modal = await screen.findByTestId('add-several');
    expect(JSON.parse(modal.dataset.defaults)).toMatchObject({ text: 'First one', source: 'typed' });
  });

  it('editing a task: no Add Several button, and a pasted list just pastes', () => {
    render(<CreateTaskModal onClose={() => {}} taskId="t9" />);
    expect(screen.queryByRole('button', { name: /Add Several/ })).toBeNull();
    const out = fireEvent.paste(screen.getByLabelText('Title'), { clipboardData: { getData: () => 'One\nTwo' } });
    expect(out).toBe(true);
    expect(screen.queryByTestId('add-several')).toBeNull();
  });
});
