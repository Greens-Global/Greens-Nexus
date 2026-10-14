import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Task templates (Neil, Oct 14 2026: "convert to task template"): Use asks
// for the new task's name, due date and field values, then the server builds
// the task, its subtasks and checklists in one go.

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
const TEMPLATE = {
  id: 'tpl1', name: 'Yearly Tax Return', description: 'Every April',
  patch: { priority: 'high', recurrence: { freq: 'yearly' }, customFieldValues: { ent: 'rjk' } },
  subtaskTitles: ['Collect K-1s', 'File extension'],
  subtasks: [{ title: 'Collect K-1s', dueOffsetDays: -45 }, { title: 'File extension', dueOffsetDays: null }],
};
const startFromTemplate = vi.fn(() => Promise.resolve({ id: 'new1' }));
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    templates: [TEMPLATE], savedViews: [], intakeForms: [], projects: [], teams: [], myEmail: 'me@x.com',
    projectName: () => '', createTask: vi.fn(), startFromTemplate,
    customFields: [{ id: 'ent', name: 'Entities', type: 'select', options: [{ id: 'rjk', label: 'RJK' }, { id: 'aus', label: 'Greens Austin' }] }],
  }),
}));

const { ProductivityBar } = await import('./productivity');
const { EMPTY_FILTER } = await import('./lib');

afterEach(() => { cleanup(); startFromTemplate.mockClear(); });

describe('Use a task template', () => {
  it('asks for the name and field values, then starts the task from the template', async () => {
    const onOpenTask = vi.fn();
    render(<ProductivityBar filters={EMPTY_FILTER} setFilters={() => {}} sort={{}} setSort={() => {}} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByTitle('Templates'));
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(screen.getByText(/2 subtasks: Collect K-1s, File extension/)).toBeTruthy();
    expect(screen.getByText(/Repeats:/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('Yearly Tax Return'), { target: { value: 'Tax Return - Greens Austin' } });
    fireEvent.change(screen.getByDisplayValue('RJK'), { target: { value: 'aus' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Task' })); });
    expect(startFromTemplate).toHaveBeenCalledWith('tpl1', {
      title: 'Tax Return - Greens Austin', dueOn: '', customFieldValues: { ent: 'aus' },
    });
    expect(onOpenTask).toHaveBeenCalledWith('new1');
  });
});
