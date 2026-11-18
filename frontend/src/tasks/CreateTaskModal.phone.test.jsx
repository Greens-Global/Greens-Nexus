// Full Details on a phone (Neil, 11/15/2026): a new task's form is the title,
// the description, then groups that say what they hold and open in place; a
// missing field turns red only after Create is pressed, which opens the group
// that holds it. Editing, and every computer, keep the form as it was.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

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
vi.mock('./RichDescription', () => ({ default: ({ short }) => <div data-testid="rich" data-short={String(!!short)} /> }));
vi.mock('./SayIt', () => ({ default: () => null }));

import CreateTaskModal from './CreateTaskModal';

let PHONE = true;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  PHONE = true;
  window.matchMedia = (q) => ({ matches: PHONE && /max-width:\s*(640|900)px/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
});
afterEach(() => { cleanup(); createTask.mockReset(); window.matchMedia = realMatchMedia; });

// Opened from the composer's Details with words already typed (11/17/2026):
// closing asks first - the form used to discard them with no question.
describe('CreateTaskModal holding what the composer typed', () => {
  const draft = { title: 'Replace gate battery', description: '<p>Front gate</p>', dueOn: '2099-01-02' };

  it('asks before it closes, and Keep Editing stays', () => {
    const onClose = vi.fn();
    render(<CreateTaskModal onClose={onClose} defaults={draft} startDirty />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
    expect(screen.getByRole('dialog', { name: 'New Task' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the same form opened clean closes straight away', () => {
    const onClose = vi.fn();
    render(<CreateTaskModal onClose={onClose} defaults={draft} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CreateTaskModal on a phone', () => {
  it('a new task: groups with what they hold, a short text toolbar, and no red before Create', () => {
    render(<CreateTaskModal onClose={() => {}} defaults={{ title: 'Order keypad', dueOn: '2099-01-02', projectId: 'p1' }} />);
    expect(screen.getByRole('dialog', { name: 'New Task' })).toBeTruthy();
    for (const g of ['When', 'People', 'Where', 'Status and Priority', 'Subtasks, Labels and Files']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${g}`) }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.getByRole('button', { name: /^When/ }).textContent).toContain('Due 01/02/2099');
    expect(screen.getByRole('button', { name: /^Where/ }).textContent).toContain('Launch Plan');
    expect(screen.getByTestId('rich').dataset.short).toBe('true');
    expect(screen.queryByText(/or press Ctrl\+V/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Create with the date missing says so and opens When; nothing is made', async () => {
    render(<CreateTaskModal onClose={() => {}} defaults={{ title: 'Order keypad' }} />);
    expect(screen.queryByText('Due Date')).toBeNull();                       // When is closed
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create Task/ })); });
    expect(createTask).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Still needed: a due date/);
    expect(screen.getByRole('button', { name: /^When/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Due Date')).toBeTruthy();
  });

  it('a group opens and closes in place', async () => {
    render(<CreateTaskModal onClose={() => {}} defaults={{ title: 'X', dueOn: '2099-01-02' }} />);
    const more = screen.getByRole('button', { name: /^Subtasks, Labels and Files/ });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Take a Photo/ })).toBeTruthy();
    fireEvent.click(more);
    expect(screen.queryByRole('button', { name: /Take a Photo/ })).toBeNull();
  });

  it('editing on a phone keeps the old form', () => {
    render(<CreateTaskModal onClose={() => {}} taskId="t9" />);
    expect(screen.getByRole('dialog', { name: 'Edit Task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^When/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Save Changes/ })).toBeTruthy();
  });

  it('a computer keeps the form as it was: every field in view, Create waits for the required ones', () => {
    PHONE = false;
    render(<CreateTaskModal onClose={() => {}} defaults={{ title: 'Order keypad' }} />);
    expect(screen.queryByRole('button', { name: /^When/ })).toBeNull();
    expect(screen.getByText('Due Date')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create Task/ }).disabled).toBe(true);
    expect(screen.getByTestId('rich').dataset.short).toBe('false');
  });
});
