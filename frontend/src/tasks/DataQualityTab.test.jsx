import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Manage > Data Quality, drawn as the Task List's table (Oct 14 2026): Title
// Case headers, Priority a solid block, Team a pill - and fixing a gap from
// the row still saves it.

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }));

const { default: DataQualityTab } = await import('./DataQualityTab');

const store = (over = {}) => ({
  tasks: [
    { id: 'a', title: 'Test', dueOn: '2026-10-22', projectId: 'p1', priority: 'medium', teamId: '', assigneeIds: ['s@x.com'] },
    { id: 'b', title: 'No date', dueOn: '', projectId: 'p1', priority: 'high', teamId: 't1', assigneeIds: ['s@x.com'] },
    { id: 'c', title: 'All good', dueOn: '2026-10-22', projectId: 'p1', priority: 'low', teamId: 't1', assigneeIds: ['s@x.com'] },
  ],
  projects: [{ id: 'p1', name: 'Test Project' }],
  teams: [{ id: 't1', name: 'IT Dev', color: '#2563eb', projectIds: ['p1'] }],
  nameOf: (e) => e, updateTask: vi.fn(), bulkUpdate: vi.fn(), deleteTask: vi.fn(),
  ...over,
});

// The clock is pinned (only Date is faked): since 11/21/2026 the list also
// holds tasks more than 90 days overdue, so "today" decides what is in it.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 21, 9, 0, 0)); });
afterEach(() => { vi.useRealTimers(); });

describe('Data Quality table', () => {
  it('lists only the tasks with a gap, under the list-style headers', () => {
    render(<DataQualityTab store={store()} />);
    // getAll: Due Date and Team are also gap chips.
    for (const h of ['Task', 'Missing', 'Due Date', 'Project', 'Priority', 'Team']) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getByText('Test')).toBeTruthy();
    expect(screen.getByText('No date')).toBeTruthy();
    expect(screen.queryByText('All good')).toBeNull();
    expect(screen.getByText('No Team')).toBeTruthy();      // Team as a pill
    expect(screen.getByText('IT Dev')).toBeTruthy();
  });

  it('fixing the priority from its block saves it', () => {
    const s = store();
    render(<DataQualityTab store={s} />);
    fireEvent.click(screen.getByText('Medium'));
    fireEvent.click(screen.getByText('Urgent'));
    expect(s.updateTask).toHaveBeenCalledWith('a', { priority: 'urgent' });
  });

  it("a header sorts, moves and resizes like the Task List's", () => {
    render(<DataQualityTab store={store()} />);
    const titles = () => [...document.querySelectorAll('.nx-row-hover')].map((r) => r.textContent.includes('No date') ? 'No date' : 'Test');
    expect(titles()).toEqual(['No date', 'Test']);             // A-Z by default
    fireEvent.click(screen.getByTitle('Sort by Priority'));     // urgent, high, medium, low
    expect(titles()).toEqual(['No date', 'Test']);
    fireEvent.click(screen.getByTitle('Sort by Priority'));     // descending
    expect(titles()).toEqual(['Test', 'No date']);
    const head = screen.getByTitle('Sort by Due Date');
    expect(head.getAttribute('draggable')).toBe('true');
    expect(head.querySelector('[title^="Drag to resize"]')).toBeTruthy();
  });

  it('alerts only for a required field; every gap is in the filter', () => {
    const s = store({ customFields: [{ id: 'ent', name: 'Entities', type: 'select', projectIds: ['p1'], requiredProjectIds: ['p1'] }] });
    render(<DataQualityTab store={s} />);
    // One chip, for the required field - none for the everyday gaps.
    expect(screen.getByText('3 missing Entities')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /missing Team/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /missing Due Date/ })).toBeNull();
    // The filter holds every kind of gap.
    fireEvent.click(screen.getByText('All Gaps (3)'));
    expect(screen.getByText('Entities - Required (3)')).toBeTruthy();
    expect(screen.getByText('Missing Due Date (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('Missing Due Date (1)'));
    expect(screen.getByText('No date')).toBeTruthy();
    expect(screen.queryByText('All good')).toBeNull();
  });
  // Long overdue (Neil, 11/21/2026): 421 open tasks in production were more
  // than 90 days past their due date.
  it('lists a task more than 90 days overdue even with nothing missing, and says how late', () => {
    const full = { projectId: 'p1', priority: 'low', teamId: 't1', assigneeIds: ['s@x.com'] };
    const s = store({ tasks: [
      { id: 'old', title: 'Renew the permit', dueOn: '2026-05-01', ...full },          // 204 days
      { id: 'older', title: 'Fix the gate', dueOn: '2025-11-21', ...full },            // 365 days
      { id: 'edge', title: 'Exactly ninety', dueOn: '2026-08-23', ...full },           // 90 days: not yet
      { id: 'late', title: 'A little late', dueOn: '2026-11-20', ...full, teamId: '' }, // 1 day, in for its gap
      { id: 'done', title: 'Finished long ago', dueOn: '2025-01-01', ...full, completed: true },
      { id: 'ok', title: 'Due next week', dueOn: '2026-11-28', ...full },
    ] });
    render(<DataQualityTab store={s} />);
    const rowOf = (title) => screen.getByText(title).closest('.nx-row-hover');
    expect(rowOf('Renew the permit').textContent).toContain('204 days');
    expect(rowOf('Fix the gate').textContent).toContain('365 days');
    expect(rowOf('A little late').textContent).toContain('1 day');
    expect(rowOf('A little late').textContent).not.toContain('1 days');
    for (const gone of ['Exactly ninety', 'Finished long ago', 'Due next week']) expect(screen.queryByText(gone)).toBeNull();
    // The filter shows just the long-overdue ones, most overdue first.
    fireEvent.click(screen.getByText('All Gaps (3)'));
    fireEvent.click(screen.getByText('Overdue More Than 90 Days (2)'));
    expect([...document.querySelectorAll('.nx-row-hover')].map((r) => (r.textContent.includes('Fix the gate') ? 'gate' : 'permit'))).toEqual(['gate', 'permit']);
    expect(screen.queryByText('A little late')).toBeNull();
    // The Overdue header sorts like any other.
    fireEvent.click(screen.getByTitle('Sort by Overdue'));
    expect([...document.querySelectorAll('.nx-row-hover')].map((r) => (r.textContent.includes('Fix the gate') ? 'gate' : 'permit'))).toEqual(['permit', 'gate']);
  });

  it('leaves the long-overdue filter out when nothing is that late', () => {
    render(<DataQualityTab store={store()} />);
    fireEvent.click(screen.getByText('All Gaps (2)'));
    expect(screen.queryByText(/Overdue More Than/)).toBeNull();
  });
});
