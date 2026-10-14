import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusLabel, PrioritySignal } from './StatusLabel';

// Soft labels replaced the solid cell fills (Neil, Oct 14 2026). Priority is a
// signal: only Urgent and High carry color.

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
  it('colors Urgent and High only, with one bar per step', () => {
    const { container, rerender } = render(<PrioritySignal priority="urgent" />);
    expect(container.querySelector('.nx-prio-loud')).toBeTruthy();
    expect(container.querySelectorAll('.nx-prio-bars i.on')).toHaveLength(3);
    rerender(<PrioritySignal priority="high" />);
    expect(container.querySelector('.nx-prio-loud')).toBeTruthy();
    rerender(<PrioritySignal priority="medium" />);
    expect(container.querySelector('.nx-prio-loud')).toBeNull();
    expect(container.querySelectorAll('.nx-prio-bars i.on')).toHaveLength(2);
    expect(screen.getByText('Medium')).toBeTruthy();
    rerender(<PrioritySignal priority="low" />);
    expect(container.querySelectorAll('.nx-prio-bars i.on')).toHaveLength(1);
  });
});
