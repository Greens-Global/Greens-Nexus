import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TimeOffBlock } from './ShiftBlock';
import { TimeOffPill } from './WeekGrid';

// A manager cancels approved time off from the planner (11/11/2026): the leave
// bar is a button only when the grid hands it `onCancel` (an approved leave,
// not over, on a row the manager edits, never their own); otherwise it stays
// the plain pill it always was.

const off = { id: 't1', type: 'personal', status: 'approved', startDate: '2026-11-13', endDate: '2026-11-16' };
const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']
  .map((d) => new Date(`${d}T12:00:00`));

describe('cancel time off from the leave bar', () => {
  it('the spanning pill is a button that runs onCancel on click, Enter and Space', () => {
    const onCancel = vi.fn();
    render(<TimeOffPill t={off} days={days} c0={4} n={3} lane={0} row={2} onCancel={onCancel} />);
    const pill = screen.getByRole('button', { name: /Cancel Time Off/ });
    fireEvent.click(pill);
    fireEvent.keyDown(pill, { key: 'Enter' });
    fireEvent.keyDown(pill, { key: ' ' });
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(pill.getAttribute('title')).toMatch(/Click to cancel this time off/);
  });

  it('without onCancel the pill is not a button', () => {
    render(<TimeOffPill t={off} days={days} c0={4} n={3} lane={0} row={2} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-timeoff="t1"]').getAttribute('title')).not.toMatch(/cancel/);
  });

  it('a partial-day block cancels the same way, and a click never reaches the cell', () => {
    const onCancel = vi.fn();
    const onCell = vi.fn();
    render(
      <div onClick={onCell}>
        <TimeOffBlock off={{ ...off, startDate: '2026-11-13', endDate: '2026-11-13', startTime: '14:00', endTime: '16:00' }} onCancel={onCancel} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel Time Off/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCell).not.toHaveBeenCalled();
  });
});
