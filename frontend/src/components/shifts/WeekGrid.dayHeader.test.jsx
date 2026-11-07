import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DayHeader } from './WeekGrid';
import { parseIso } from './shiftLib';

// The line under each planner day (11/05/2026): it used to read a bare "0"
// when hours were hidden. It now says what it counts, and an empty day says
// nothing.
afterEach(cleanup);
const line = (stats) => {
  const { container } = render(<DayHeader d={parseIso('2026-11-03')} stats={stats} />);
  return container.querySelector('[role="columnheader"] > div:nth-child(2)').textContent;
};

describe('DayHeader count line', () => {
  it('labels the shift count, with the hours when they are shown', () => {
    expect(line({ shifts: 3, people: 3 })).toBe('3 Shifts');
    cleanup();
    expect(line({ shifts: 1, people: 1, min: 480 })).toMatch(/^1 Shift · .+ Hrs$/);
  });

  it('shows no bare zero on a day with no shifts', () => {
    expect(line({ shifts: 0, people: 0 })).toBe(' ');
    cleanup();
    expect(line({ shifts: 0, people: 0, min: 0 })).toBe(' ');
  });
});
