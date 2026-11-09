import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Automatic scheduling + baselines on the Timeline (Neil, 11/08/2026): an
// auto task's bar carries the link glyph, a manual successor that starts
// before its predecessor finishes gets the amber bracket, the Baseline menu
// lists and takes baselines, and a picked one draws the ghosts, the slips and
// the Changes Since panel.

const apiMock = vi.hoisted(() => ({
  rescheduleTask: vi.fn(), getTaskAttachments: () => Promise.resolve([]), getPersonPhotos: () => Promise.resolve({}),
  getPeopleDirectory: () => Promise.resolve([]),
  getTaskProjectBaselines: vi.fn(), getTaskProjectBaselineDiff: vi.fn(), takeTaskProjectBaseline: vi.fn(), deleteTaskProjectBaseline: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../TasksContext', () => ({ useTasks: () => ({ applyServerTask: vi.fn(), offerUndo: vi.fn() }) }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));

const { TimelineView, earliestStart, startsTooEarly } = await import('./more');

const tasks = [
  { id: 'a', title: 'Demo', status: 'in_progress', startOn: '2026-11-09', dueOn: '2026-11-12', blockingIds: ['b', 'c'], assigneeIds: [] },
  // Auto, lag 2: follows Demo.
  { id: 'b', title: 'Footings', status: 'not_started', startOn: '2026-11-17', dueOn: '2026-11-19', blockedByIds: ['a'], dependencyLags: { a: 2 }, scheduleMode: 'auto', assigneeIds: [] },
  // Manual, starts the day Demo is still running: the bracket.
  { id: 'c', title: 'Posts', status: 'not_started', startOn: '2026-11-12', dueOn: '2026-11-13', blockedByIds: ['a'], assigneeIds: [] },
];
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));

const diff = {
  id: 'bl1', name: 'Plan A', takenAt: '2026-11-01T10:00:00+00:00', takenBy: 'sam@x.com', count: 3, unchanged: 1,
  snapshot: [
    { id: 'a', title: 'Demo', start: '2026-11-09', due: '2026-11-12' },
    { id: 'b', title: 'Footings', start: '2026-11-13', due: '2026-11-16' },
    { id: 'c', title: 'Posts', start: '2026-11-12', due: '2026-11-16' },
  ],
  moved: [
    { id: 'b', title: 'Footings', from: { start: '2026-11-13', due: '2026-11-16' }, to: { start: '2026-11-17', due: '2026-11-19' }, slipDays: 3 },
    { id: 'c', title: 'Posts', from: { start: '2026-11-12', due: '2026-11-16' }, to: { start: '2026-11-12', due: '2026-11-13' }, slipDays: -1 },
  ],
  added: [{ id: 'd', title: 'Paint', start: '2026-11-20', due: '2026-11-20' }],
  removed: [{ id: 'z', title: 'Old Fence', start: '2026-11-09', due: '2026-11-09' }],
};

describe('working-day arithmetic for the bracket', () => {
  it('earliest start is the predecessor due + lag + 1 working day, weekends skipped', () => {
    const lookup = (id) => taskById[id];
    expect(earliestStart(taskById.b, lookup)).toBe('2026-11-17');      // Thu 11/12 + 3 working days
    expect(earliestStart(taskById.c, lookup)).toBe('2026-11-13');      // Thu + 1 = Fri
    expect(earliestStart({ blockedByIds: ['a'], dependencyLags: { a: 0 }, startOn: '' }, () => ({ dueOn: '2026-11-13' }))).toBe('2026-11-16');   // Fri -> Mon
    expect(startsTooEarly(taskById.c, lookup)).toBe(true);
    expect(startsTooEarly(taskById.b, lookup)).toBe(false);            // auto tasks are never warned
  });

  it('follows the dependency type the way the server does (SS, FF, SF)', () => {
    const pred = () => ({ startOn: '2026-11-09', dueOn: '2026-11-11' });   // Mon - Wed
    const two = { blockedByIds: ['a'], startOn: '2026-11-12', dueOn: '2026-11-13' };   // two working days
    expect(earliestStart({ ...two, dependencyTypes: { a: 'SS' } }, pred)).toBe('2026-11-09');
    expect(earliestStart({ ...two, dependencyTypes: { a: 'SS' }, dependencyLags: { a: 1 } }, pred)).toBe('2026-11-10');
    expect(earliestStart({ ...two, dependencyTypes: { a: 'FF' } }, pred)).toBe('2026-11-10');   // due Wed, start Tue
    expect(earliestStart({ ...two, dependencyTypes: { a: 'FF' }, dependencyLags: { a: 2 } }, pred)).toBe('2026-11-12');
    expect(earliestStart({ ...two, dependencyTypes: { a: 'SF' }, dependencyLags: { a: 1 } }, pred)).toBe('2026-11-09');
    expect(earliestStart({ ...two, dependencyTypes: { a: 'FS' } }, pred)).toBe('2026-11-12');
    // A manual SS successor that starts before its predecessor starts is warned; one on the same day is not.
    expect(startsTooEarly({ ...two, startOn: '2026-11-06', dependencyTypes: { a: 'SS' } }, pred)).toBe(true);
    expect(startsTooEarly({ ...two, startOn: '2026-11-09', dependencyTypes: { a: 'SS' } }, pred)).toBe(false);
  });
});

describe('TimelineView scheduling marks', () => {
  it('marks auto bars and a manual successor that starts too early', () => {
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} taskById={taskById} />);
    expect(screen.getByLabelText('Footings').getAttribute('data-auto')).toBe('true');
    expect(screen.getByLabelText('Footings').title).toMatch(/automatic/);
    expect(screen.getByLabelText('Demo').getAttribute('data-auto')).toBeNull();
    expect(screen.getByTitle('Starts before its predecessor finishes')).toBeInTheDocument();
    expect(screen.queryAllByTitle('Starts before its predecessor finishes')).toHaveLength(1);
  });
});

describe('TimelineView baselines', () => {
  beforeEach(() => {
    apiMock.getTaskProjectBaselines.mockReset().mockResolvedValue([{ id: 'bl1', name: 'Plan A', takenAt: diff.takenAt, takenBy: 'sam@x.com', count: 3 }]);
    apiMock.getTaskProjectBaselineDiff.mockReset().mockResolvedValue(diff);
    apiMock.takeTaskProjectBaseline.mockReset().mockResolvedValue({ id: 'bl2', name: 'Baseline 11/08/2026', takenAt: '2026-11-08T12:00:00+00:00', takenBy: 'me', count: 3 });
  });

  it('has no Baseline menu outside a project', () => {
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} />);
    expect(screen.queryByRole('button', { name: /Baseline/ })).toBeNull();
  });

  it('lists the baselines, takes one, and draws ghosts, slips and the panel for the one picked', async () => {
    const onOpen = vi.fn();
    render(<TimelineView tasks={tasks} onOpen={onOpen} nameOf={(e) => e} taskById={taskById} projectId="p1" projectRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: /^Baseline$/ }));
    await waitFor(() => expect(screen.getByText('Plan A')).toBeInTheDocument());
    expect(screen.getByRole('menuitem', { name: /Take Baseline/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Delete baseline Plan A, press and hold')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Plan A'));
    await waitFor(() => expect(apiMock.getTaskProjectBaselineDiff).toHaveBeenCalledWith('p1', 'bl1'));
    // Ghosts under every baselined bar, the slips at the moved bars' ends.
    await waitFor(() => expect(document.querySelectorAll('[data-ghost]')).toHaveLength(3));
    expect(document.querySelector('[data-slip="b"]').textContent).toBe('+3d');
    expect(document.querySelector('[data-slip="c"]').textContent).toBe('-1d');
    expect(document.querySelector('[data-slip="a"]')).toBeNull();
    // The Changes Since panel with its three sections.
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText('Changes Since Plan A')).toBeInTheDocument();
    expect(within(panel).getByText('Moved · 2')).toBeInTheDocument();
    expect(within(panel).getByText('Paint')).toBeInTheDocument();
    expect(within(panel).getByText('Old Fence')).toBeInTheDocument();
    expect(within(panel).getByText(/1 task unchanged/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByText('Paint'));
    expect(onOpen).toHaveBeenCalledWith('d');
    // Clear hides the ghosts.
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(document.querySelectorAll('[data-ghost]')).toHaveLength(0));

    fireEvent.click(screen.getByRole('button', { name: /^Baseline$/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Take Baseline/ }));
    await waitFor(() => expect(apiMock.takeTaskProjectBaseline).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Baseline "Baseline 11/08/2026" saved with 3 tasks.'));
  });

  it('a viewer sees the list but neither Take Baseline nor Delete', async () => {
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} taskById={taskById} projectId="p1" projectRole="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: /^Baseline$/ }));
    await waitFor(() => expect(screen.getByText('Plan A')).toBeInTheDocument());
    expect(screen.queryByRole('menuitem', { name: /Take Baseline/ })).toBeNull();
    expect(screen.queryByLabelText(/Delete baseline/)).toBeNull();
  });
});
