import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EmployeeCombobox from './EmployeeCombobox';
import { matchPeople } from '../lib/peopleSearch';

// Time Sheet employee picker (Sep 30): typing FILTERS the list instead of the
// native <select> only highlighting a name somewhere in a long list.

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

const people = [
  { email: 'zed@x.com', name: 'Zed Amyson' },
  { email: 'bob@x.com', name: 'Bob Stone' },
  { email: 'amy@x.com', name: 'Amy Wilson' },
  { email: 'will@x.com', name: 'Will Park' },
  { email: 'carl@x.com', name: 'Carl Oswil' },
];

const setup = (value = 'bob@x.com') => {
  const onChange = vi.fn();
  render(<EmployeeCombobox people={people} value={value} onChange={onChange} labelFor={p => p.name} />);
  return { onChange, input: screen.getByRole('combobox', { name: 'Employee' }) };
};
const optionNames = () => screen.queryAllByRole('option').map(o => o.textContent);

describe('EmployeeCombobox', () => {
  it('shows the selected person when closed and the full list when opened', () => {
    const { input } = setup();
    expect(input.value).toBe('Bob Stone');
    fireEvent.focus(input);
    expect(optionNames()).toEqual(people.map(p => p.name));
    // Opens on the current pick, so Enter without typing keeps it.
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Bob Stone');
  });

  it('filters by first or last name, case-insensitive, prefixes first', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'WIL' } });
    // Will (first-name prefix) > Amy Wilson (last-name prefix) > Carl Oswil (mid-word).
    expect(optionNames()).toEqual(['Will Park', 'Amy Wilson', 'Carl Oswil']);
    fireEvent.change(input, { target: { value: 'amy' } });
    expect(optionNames()).toEqual(['Amy Wilson', 'Zed Amyson']);
  });

  it('pre-selects the top match so Enter picks it; arrows move', () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'amy' } });
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Amy Wilson');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Zed Amyson');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('amy@x.com');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('shows "No matches", Escape closes, and clearing restores everyone', () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'qqq' } });
    expect(optionNames()).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    expect(optionNames()).toHaveLength(people.length);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks with the mouse', () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Will Park' }));
    expect(onChange).toHaveBeenCalledWith('will@x.com');
  });
});

describe('matchPeople ranking', () => {
  it('ranks first-name prefix, then other-word prefix, then substring', () => {
    expect(matchPeople(people, 'wil').map(p => p.name)).toEqual(['Will Park', 'Amy Wilson', 'Carl Oswil']);
    expect(matchPeople(people, '')).toBe(people);
  });
});
