import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PersonSearchSelect from './PersonSearchSelect';

// Like the Tasks picker (Oct 25 2026): each group ranks first-name matches
// first, and while nothing is typed a "Recent" group leads - its people stay
// in their own groups too. Rows keep "title · email".

const many = Array.from({ length: 13 }, (_, i) => ({ email: `p${i}@x.com`, name: `Person ${String(i).padStart(2, '0')}` }));
const groups = [
  { label: 'Nexus People', people: [{ email: 'charmi@x.com', name: 'Charmi Desai', title: 'Accountant' }, { email: 'sai@x.com', name: 'Sai Patel' }, ...many] },
  { label: 'External Users', people: [{ email: 'owner@gmail.com', name: 'Pat Owner' }] },
];

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

const setup = () => {
  const onPick = vi.fn();
  render(<PersonSearchSelect groups={groups} onPick={onPick} placeholder="Type a name" />);
  return { onPick, input: screen.getByPlaceholderText('Type a name') };
};
// children[0] is the face (Oct 28 2026), children[1] the name.
const names = () => screen.getAllByRole('option').map((o) => o.children[1].textContent);

describe('PersonSearchSelect ranking and Recent', () => {
  it('ranks a first-name match ahead of a mid-word hit, keeping the title', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'sai' } });
    expect(names()).toEqual(['Sai Patel', 'Charmi Desai']);
    expect(screen.getByText('Accountant · charmi@x.com')).toBeTruthy();
  });

  it('nothing until someone is picked, then Recent first; a search hides it', () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    expect(screen.queryByText('Recent')).toBeNull();
    fireEvent.change(input, { target: { value: 'person 07' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('p7@x.com');
    fireEvent.blur(input);
    fireEvent.focus(input);
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(names()[0]).toBe('Person 07');
    expect(names().filter((n) => n === 'Person 07')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('p7@x.com');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pat' } });
    expect(screen.queryByText('Recent')).toBeNull();
  });
});
