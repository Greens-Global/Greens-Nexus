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
