import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Timeline drag (Oct 2026): a bar dragged two days to the right asks the
// server to move the task, the moved dependents come back into the store,
// and the click that ends the drag does not open the task.

const rescheduleTask = vi.fn();
vi.mock('../../api', () => ({ api: { rescheduleTask: (...a) => rescheduleTask(...a), getTaskAttachments: () => Promise.resolve([]), getPersonPhotos: () => Promise.resolve({}), getPeopleDirectory: () => Promise.resolve([]) } }));
const applyServerTask = vi.fn();
vi.mock('../TasksContext', () => ({ useTasks: () => ({ applyServerTask }) }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));

const { TimelineView } = await import('./more');

// jsdom has no PointerEvent, and a generic Event carries no clientX. React
// routes by event name, so a MouseEvent dispatched as "pointerdown" reaches
// onPointerDown with real coordinates.
const pointer = (el, type, clientX) => fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));

const tasks = [
  { id: 'a', title: 'Pour slab', status: 'in_progress', startOn: '2026-10-01', dueOn: '2026-10-03', blockingIds: ['b'], assigneeIds: [] },
  { id: 'b', title: 'Frame walls', status: 'not_started', startOn: '2026-10-03', dueOn: '2026-10-06', blockedByIds: ['a'], assigneeIds: [] },
];

describe('TimelineView drag', () => {
  beforeEach(() => { rescheduleTask.mockReset(); applyServerTask.mockReset(); });

  it('moves a bar by whole days and hands the moved tasks to the store', async () => {
    rescheduleTask.mockResolvedValue({
      task: { ...tasks[0], startOn: '2026-10-03', dueOn: '2026-10-05' },
      moved: [{ ...tasks[1], startOn: '2026-10-05', dueOn: '2026-10-08' }],
      skipped: [],
    });
    const onOpen = vi.fn();
    render(<TimelineView tasks={tasks} onOpen={onOpen} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Pour slab');
    // Grabbed in the middle of a 3-day (78px) bar, dragged 52px = 2 days.
    pointer(bar, 'pointerdown', 30);
    pointer(bar, 'pointermove', 82);
    pointer(bar, 'pointerup', 82);
    fireEvent.click(bar);
    await waitFor(() => expect(rescheduleTask).toHaveBeenCalledWith('a', { start_on: '2026-10-03', due_on: '2026-10-05' }));
    await waitFor(() => expect(applyServerTask).toHaveBeenCalledTimes(2));
    expect(applyServerTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', dueOn: '2026-10-08' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Moved "Pour slab" to 10/03/2026 - 10/05/2026 · 1 dependent task moved');
  });

  it('a click without movement still opens the task and sends nothing', () => {
    const onOpen = vi.fn();
    render(<TimelineView tasks={tasks} onOpen={onOpen} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Frame walls');
    pointer(bar, 'pointerdown', 30);
    pointer(bar, 'pointerup', 34);
    fireEvent.click(bar);
    expect(rescheduleTask).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith('b');
  });

  it('dragging the end edge changes only the due date', async () => {
    rescheduleTask.mockResolvedValue({ task: tasks[0], moved: [], skipped: [{ id: 'b', title: 'Frame walls' }] });
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Pour slab');
    // jsdom has no layout: the bar's rect is 0 wide, so width falls back to the
    // 78px geometry and a grab at x=75 is inside the 7px end handle.
    pointer(bar, 'pointerdown', 75);
    pointer(bar, 'pointermove', 101);
    pointer(bar, 'pointerup', 101);
    await waitFor(() => expect(rescheduleTask).toHaveBeenCalledWith('a', { start_on: '2026-10-01', due_on: '2026-10-04' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 not moved (no access)'));
  });
});
