import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RangePill from './RangePill';

// The one bounded date-range control (11/03/2026): arrows step a whole
// period, From / To picks keep the pair ordered, and the quick reset jumps
// back to the usual range.

describe('RangePill', () => {
  it('shows the range and steps a whole period with the arrows', () => {
    const onChange = vi.fn();
    render(<RangePill start="2026-10-05" end="2026-10-11" onChange={onChange} />);
    expect(screen.getByTitle('Pick the dates').textContent).toBe('10/05/2026 - 10/11/2026');
    fireEvent.click(screen.getByLabelText('Previous period'));
    expect(onChange).toHaveBeenLastCalledWith('2026-09-28', '2026-10-04');
    fireEvent.click(screen.getByLabelText('Next period'));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-12', '2026-10-18');
  });

  it('keeps the pair ordered when a pick crosses the other date', () => {
    const onChange = vi.fn();
    render(<RangePill start="2026-10-05" end="2026-10-11" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Pick the dates'));
    fireEvent.click(screen.getByTitle('From date'));
    fireEvent.click(screen.getByRole('button', { name: '10/20/2026' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-20', '2026-10-20');   // To follows From forward
    fireEvent.click(screen.getByTitle('To date'));
    fireEvent.click(screen.getByRole('button', { name: '10/01/2026' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-01', '2026-10-01');   // From follows To back
  });

  it('resets to the quick range', () => {
    const onChange = vi.fn();
    render(<RangePill start="2026-10-05" end="2026-10-11" onChange={onChange}
      reset={{ label: 'This Week', range: () => ['2026-11-02', '2026-11-08'] }} />);
    fireEvent.click(screen.getByTitle('Pick the dates'));
    fireEvent.click(screen.getByRole('button', { name: 'This Week' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-02', '2026-11-08');
  });
});
