import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Timeline on a phone (Oct 21 2026): the title column is narrower and sticks
// while the dates scroll, and a finger swiping across the bars scrolls the
// chart - a bar is picked up only after a long press. Desktop drag is covered,
// unchanged, by timelineDrag.test.jsx.

const rescheduleTask = vi.fn(() => Promise.resolve({ task: null, moved: [], skipped: [] }));
vi.mock('../../api', () => ({ api: { rescheduleTask: (...a) => rescheduleTask(...a), getTaskAttachments: () => Promise.resolve([]), getPersonPhotos: () => Promise.resolve({}), getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('../TasksContext', () => ({ useTasks: () => ({ applyServerTask: () => {} }) }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));

const { TimelineView } = await import('./more');

const touch = (el, type, clientX, clientY = 10) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  Object.defineProperty(ev, 'pointerType', { value: 'touch' });
  Object.defineProperty(ev, 'pointerId', { value: 7 });
  fireEvent(el, ev);
};

const tasks = [
  { id: 'a', title: 'Pour slab', status: 'in_progress', startOn: '2026-10-01', dueOn: '2026-10-03', assigneeIds: [] },
];

function phone(on) {
  globalThis.matchMedia = (q) => ({
    matches: on && q.includes('max-width: 640px'), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

describe('Timeline on a phone', () => {
  beforeEach(() => { rescheduleTask.mockClear(); phone(true); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); phone(false); });

  it('keeps a narrower title column pinned while the dates scroll', () => {
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} />);
    const col = screen.getByTestId('timeline-titles');
    expect(col.style.position).toBe('sticky');
    expect(col.style.left).toBe('0px');
    expect(col.style.width).toBe('128px');
    expect(screen.getByLabelText('Pour slab').style.touchAction).toBe('pan-x pan-y');
  });

  it('a swipe across a bar scrolls - it never moves the task', async () => {
    const onOpen = vi.fn();
    render(<TimelineView tasks={tasks} onOpen={onOpen} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Pour slab');
    touch(bar, 'pointerdown', 30);
    touch(bar, 'pointermove', 90);          // moved before the long press landed
    await act(async () => { vi.advanceTimersByTime(500); });
    touch(bar, 'pointermove', 140);
    touch(bar, 'pointerup', 140);
    expect(rescheduleTask).not.toHaveBeenCalled();
  });

  it('a long press picks the bar up, and then it drags by whole days', async () => {
    render(<TimelineView tasks={tasks} onOpen={() => {}} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Pour slab');
    touch(bar, 'pointerdown', 30);
    await act(async () => { vi.advanceTimersByTime(400); });
    touch(bar, 'pointermove', 82);
    await act(async () => { touch(bar, 'pointerup', 82); });
    expect(rescheduleTask).toHaveBeenCalledWith('a', { start_on: '2026-10-03', due_on: '2026-10-05' });
  });

  it('a quick tap still opens the task', () => {
    const onOpen = vi.fn();
    render(<TimelineView tasks={tasks} onOpen={onOpen} nameOf={(e) => e} />);
    const bar = screen.getByLabelText('Pour slab');
    touch(bar, 'pointerdown', 30);
    touch(bar, 'pointerup', 31);
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenCalledWith('a');
    expect(rescheduleTask).not.toHaveBeenCalled();
  });
});
