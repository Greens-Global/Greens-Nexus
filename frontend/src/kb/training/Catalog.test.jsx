// Render-smoke for Training > Catalog (11/07/2026): the paths for your role
// lead, courses shelve by department, the filters narrow the list.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const CATALOG = {
  me: { department: 'Operations', job_title: 'Site Manager', location: 'Temecula' },
  departments: ['Accounting', 'Operations'],
  can_author: false,
  courses: [
    { id: 'c1', code: 'LRN-001', title: 'Cubby Fundamentals', description: 'Cubby, the software Greens runs its sites on.', department_list: ['Operations'], level: 'core', tags: ['cubby'], est_minutes: 180, lesson_count: 19, my_status: 'In Progress', my_pct: 35, assigned: true, due_date: '2026-11-30', days_overdue: 0, delivery: 'online' },
    { id: 'c2', code: 'LRN-002', title: 'Month-End Close', description: '', department_list: ['Accounting'], level: 'advanced', tags: [], est_minutes: 45, lesson_count: 4, my_status: 'Not Started', my_pct: 0, assigned: false, due_date: '', days_overdue: 0, delivery: 'online' },
    { id: 'c3', code: 'LRN-003', title: 'Hands-On Check', description: '', department_list: ['Operations'], level: 'core', tags: [], est_minutes: 90, lesson_count: 1, my_status: 'Not Started', my_pct: 0, assigned: false, due_date: '', days_overdue: 0, delivery: 'in_person' },
  ],
  paths: [
    { id: 'p1', name: 'Site Manager Path', description: 'Everything a site manager needs.', kind: 'role', stages: ['Week 1', 'Week 2'], items: [{ kind: 'course', id: 'c1', title: 'Cubby Fundamentals', done: false, status: 'In Progress', stage: 0 }, { kind: 'course', id: 'c3', title: 'Hands-On Check', done: false, status: 'Not Started', stage: 1 }], done: 0, total: 2, est_minutes: 270, open_enrollment: true, active: true, audience_text: 'Site Manager', enrolled: false, for_me: true, source: '', due_date: '', completed_at: '', days_overdue: 0 },
    { id: 'p2', name: 'Accounting Training', description: '', kind: 'department', stages: [], items: [{ kind: 'course', id: 'c2', title: 'Month-End Close', done: false, status: 'Not Started', stage: -1 }], done: 0, total: 1, est_minutes: 45, open_enrollment: false, active: true, audience_text: 'Accounting', enrolled: false, for_me: false, source: '', due_date: '', completed_at: '', days_overdue: 0 },
  ],
};
vi.mock('../../api', () => {
  const api = { kbCatalog: () => Promise.resolve(CATALOG) };
  return { api, default: api, saveBlob: () => {}, API_BASE: 'http://localhost:8000' };
});

const { default: Catalog } = await import('./Catalog');
const { ToastProvider } = await import('../components/Toast');
afterEach(cleanup);

describe('Training > Catalog', () => {
  it('leads with the path for your role, then the other paths and the courses by department', async () => {
    render(<ToastProvider><Catalog me={{ can_author: false }} /></ToastProvider>);
    expect(await screen.findByText('For You')).toBeTruthy();
    expect(screen.getByText('Site Manager Path')).toBeTruthy();
    expect(screen.getByText('For Your Role')).toBeTruthy();
    expect(screen.getByText('Department Training')).toBeTruthy();
    expect(screen.getByText('Accounting Training')).toBeTruthy();
    // your own department's shelf comes first
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads.indexOf('Operations')).toBeLessThan(heads.indexOf('Accounting'));
    expect(screen.getByText('Cubby Fundamentals')).toBeTruthy();
    expect(screen.getByText('In Person')).toBeTruthy();
    expect(screen.getByText('3 hr')).toBeTruthy();
    expect(screen.getByText('Continue')).toBeTruthy();
  });

  it('narrows to a level and finds nothing with a stray word', async () => {
    render(<ToastProvider><Catalog me={{ can_author: false }} /></ToastProvider>);
    await screen.findByText('For You');
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'advanced' } });
    expect(screen.getByText('Month-End Close')).toBeTruthy();
    expect(screen.queryByText('Cubby Fundamentals')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: 'zebra' } });
    expect(await screen.findByText('Nothing Matches')).toBeTruthy();
  });
});
