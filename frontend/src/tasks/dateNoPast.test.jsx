import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { DateField, localTodayISO, notPast } from './components';

// A due date cannot be set in the past: with `noPast` the calendar greys out
// and disables every day before today, while today and later stay pickable.

describe('DateField noPast', () => {
  it('disables days before today and keeps today pickable', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 18, 21, 30));   // Sept 18 2026, evening local
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} noPast placeholder="Pick a date" />);
    fireEvent.click(screen.getByText('Pick a date'));
    const d17 = screen.getAllByRole('button', { name: '17' })[0];
    expect(d17.disabled).toBe(true);
    fireEvent.click(d17);
    expect(onChange).not.toHaveBeenCalled();
    const d18 = screen.getAllByRole('button', { name: '18' })[0];
    expect(d18.disabled).toBe(false);
    fireEvent.click(d18);
    expect(onChange).toHaveBeenCalledWith('2026-09-18');
    vi.useRealTimers();
  });

  it('uses the local date, not UTC, for "today"', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 18, 23, 50));
    expect(localTodayISO()).toBe('2026-09-18');
    expect(notPast('2026-09-17')).toBe('');
    expect(notPast('2026-09-18')).toBe('2026-09-18');
    vi.useRealTimers();
  });
});
