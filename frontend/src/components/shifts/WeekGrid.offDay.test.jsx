import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import WeekGrid from './WeekGrid';
import { timeOffOn } from './shiftLib';

// Gray leave days (Pranshu, 11/12/2026): a person's cell is grayed on each day
// of approved full-day leave; pending, partial-day and cancelled leave are not.

const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map((d) => new Date(`${d}T12:00:00`));
const timeoff = [
  { id: 'a', email: 'amy@x.com', type: 'vacation', status: 'approved', startDate: '2026-11-09', endDate: '2026-11-10' },
  { id: 'b', email: 'amy@x.com', type: 'personal', status: 'cancelled', startDate: '2026-11-11', endDate: '2026-11-11' },
  { id: 'c', email: 'amy@x.com', type: 'personal', status: 'pending', startDate: '2026-11-12', endDate: '2026-11-12' },
  { id: 'd', email: 'bob@x.com', type: 'personal', status: 'approved', startDate: '2026-11-09', endDate: '2026-11-09', startTime: '14:00', endTime: '16:00' },
];
const sections = [{ id: 'g1', name: 'Crew', isGroup: false, members: [
  { email: 'amy@x.com', name: 'Amy Adams', availability: [] },
  { email: 'bob@x.com', name: 'Bob Brown', availability: [] },
] }];

describe('approved leave grays the day', () => {
  it('grays only approved full-day leave', () => {
    const { container } = render(
      <WeekGrid days={days} sections={sections} byCell={{}} openCells={{}} offOn={(e, ds) => timeOffOn(timeoff, e, ds)}
        empWeekMin={() => 0} dayStats={() => ({})} weekMin={0} />,
    );
    const gray = [...container.querySelectorAll('[data-off-day]')].map((el) => el.getAttribute('data-cell'));
    expect(gray).toEqual(['amy@x.com|2026-11-09', 'amy@x.com|2026-11-10']);
    expect(container.querySelector('[data-cell="amy@x.com|2026-11-09"]').getAttribute('aria-label')).toMatch(/on approved time off/);
  });
});
