import { describe, it, expect, vi, afterEach } from 'vitest';
import { openPersonTasks } from './personTasksNav';

// A person opened from search outside Tasks is marked so Tasks hides its tab
// strip and Back returns to that screen (Sagar, Oct 27).
describe('openPersonTasks', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); vi.useRealTimers(); });

  const opened = (path) => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', path);
    const seen = vi.fn();
    window.addEventListener('nexus:tasks-person', seen);
    openPersonTasks('Pragya@X.com', 'Pragya');
    vi.advanceTimersByTime(1);
    window.removeEventListener('nexus:tasks-person', seen);
    return seen.mock.calls[0][0].detail;
  };

  it('marks a jump from another module as from outside', () => {
    expect(opened('/workday/overview')).toEqual({ email: 'pragya@x.com', name: 'Pragya', fromOutside: true });
  });

  it('keeps the module tabs for a jump made inside Tasks', () => {
    expect(opened('/tasks/projects').fromOutside).toBe(false);
    expect(opened('/tasks').fromOutside).toBe(false);
    expect(opened('/tasksboard').fromOutside).toBe(true);
  });
});
