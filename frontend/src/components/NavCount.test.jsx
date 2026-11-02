import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import NavCount from './NavCount';

// A waiting count that changes while the rail is on screen bumps once
// (rail motion, 11/01/2026) - the same quiet gray number, never a red pill.

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('NavCount', () => {
  it('bumps once when the number changes, not on first paint, and clears on a timer', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<NavCount n={3} order={4} />);
    const el = () => container.querySelector('.nav-count');
    expect(el().textContent).toBe('3');
    expect(el().classList.contains('is-bump')).toBe(false);
    expect(el().style.getPropertyValue('--i')).toBe('4');
    rerender(<NavCount n={4} order={4} />);
    expect(el().classList.contains('is-bump')).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(el().classList.contains('is-bump')).toBe(false);
  });

  it('arriving from nothing is not a bump (the count-in animation already covers it)', () => {
    const { container, rerender } = render(<NavCount n={0} />);
    expect(container.querySelector('.nav-count')).toBeNull();
    rerender(<NavCount n={2} />);
    expect(container.querySelector('.nav-count').classList.contains('is-bump')).toBe(false);
  });

  it('the corner dot is unchanged', () => {
    const { container } = render(<NavCount n={5} corner />);
    expect(container.querySelector('.nav-count.is-corner')).toBeTruthy();
    expect(container.textContent).toBe('');
  });
});
