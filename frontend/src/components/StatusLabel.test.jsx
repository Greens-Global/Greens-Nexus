import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusLabel, PrioritySignal } from './StatusLabel';

// Soft labels replaced the solid cell fills (Neil, Oct 14 2026). Priority is a
// chevron mark: only Urgent and High color the word.

afterEach(cleanup);

describe('StatusLabel', () => {
  it('draws the words on a soft label in its color', () => {
    const { container } = render(<StatusLabel label="In Progress" color="#d97706" />);
    expect(screen.getByText('In Progress')).toBeTruthy();
    const el = container.querySelector('.nx-label');
    expect(el.style.getPropertyValue('--c')).toBe('#d97706');
    expect(el.style.background).toBe('');   // no solid fill inline
  });
});

describe('PrioritySignal', () => {
  // Chevrons since Oct 28 2026: every level its own shape (Urgent two paths,
  // the rest one), no bars left anywhere.
  const paths = (c) => c.querySelectorAll('svg.nx-prio-mark path').length;
  it('colors the word for Urgent and High only, and gives each level its own chevron', () => {
    const { container, rerender } = render(<PrioritySignal priority="urgent" />);
    expect(container.querySelector('.nx-prio-loud')).toBeTruthy();
    expect(paths(container)).toBe(2);
    const urgent = container.querySelector('svg').innerHTML;
    rerender(<PrioritySignal priority="high" />);
    expect(container.querySelector('.nx-prio-loud')).toBeTruthy();
    expect(paths(container)).toBe(1);
    const high = container.querySelector('svg').innerHTML;
    rerender(<PrioritySignal priority="medium" />);
    expect(container.querySelector('.nx-prio-loud')).toBeNull();
    expect(screen.getByText('Medium')).toBeTruthy();
    const medium = container.querySelector('svg').innerHTML;
    rerender(<PrioritySignal priority="low" />);
    const low = container.querySelector('svg').innerHTML;
    expect(new Set([urgent, high, medium, low]).size).toBe(4);
    expect(container.querySelector('.nx-prio-bars')).toBeNull();
  });

  it('draws no mark for an unknown priority, just the word', () => {
    const { container } = render(<PrioritySignal priority="someday" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('someday')).toBeTruthy();
  });
});
