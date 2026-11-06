import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TasksLoading from './TasksLoading';

// While task data is still arriving the Tasks screen shows this instead of an
// empty list ("0 Tasks", "No Tasks") - and says so when a task link is being
// opened (Sep 28).

afterEach(() => vi.useRealTimers());

describe('TasksLoading', () => {
  it('says the tasks are loading, as a busy status', () => {
    render(<TasksLoading />);
    expect(screen.getByText('Loading your tasks…')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/No Tasks/)).toBeNull();
  });

  it('is shaped like the page it turns into, full width, with no spinner (11/05/2026)', () => {
    const { container, unmount } = render(<TasksLoading />);
    const status = screen.getByRole('status');
    expect(status.dataset.tasksLoading).toBe('home');           // Home: tiles and two columns
    expect(status.style.maxWidth).toBe('');
    expect(status.style.width).toBe('100%');
    expect(container.querySelector('svg')).toBeNull();          // no ring
    expect(container.querySelectorAll('.skel').length).toBeGreaterThan(10);
    unmount();
    render(<TasksLoading sub="mine" />);
    expect(screen.getByRole('status').dataset.tasksLoading).toBe('list');
  });

  it('says it is opening the task when one was linked', () => {
    render(<TasksLoading opening />);
    expect(screen.getByText('Opening your task…')).toBeTruthy();
  });

  it('admits it is slow after a while instead of looking frozen', () => {
    vi.useFakeTimers();
    render(<TasksLoading />);
    expect(screen.queryByText(/taking a little longer/)).toBeNull();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText(/taking a little longer than usual/)).toBeTruthy();
  });
});
