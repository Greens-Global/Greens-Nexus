import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PeoplePick, { PeopleMultiPick } from './PeoplePick';

// The KB people pickers work like the Tasks one (Oct 25 2026): first-name
// matches ranked first (department / job title still match), arrows + Enter,
// Esc closes, and a "Recent" group while nothing is typed. Rows keep their
// title / department meta and role tag.

const people = [
  { email: 'charmi@x.com', name: 'Charmi Desai', role: 'employee', job_title: 'Accountant', department: 'Finance' },
  { email: 'sai@x.com', name: 'Sai Patel', role: 'employee', job_title: 'Engineer', department: 'IT' },
  { email: 'mgr@x.com', name: 'Zed Boss', role: 'manager', job_title: 'Director', department: 'Operations' },
  ...Array.from({ length: 13 }, (_, i) => ({ email: `p${i}@x.com`, name: `Person ${String(i).padStart(2, '0')}`, role: 'employee', job_title: '', department: '' })),
];

vi.mock('../../api', () => ({ api: { kbPeople: () => Promise.resolve(people) } }));

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

const box = () => screen.getByPlaceholderText('Search people');
const names = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.querySelector('.kb-grow').firstChild.textContent);
const captions = () => ['Recent', 'All'].filter((c) => screen.queryByText(c));

function Single({ preferManagers = false, onPick = () => {} }) {
  const [v, setV] = useState('');
  return <PeoplePick value={v} onChange={(e) => { setV(e); onPick(e); }} preferManagers={preferManagers} />;
}

describe('PeoplePick', () => {
  it('ranks a first-name match ahead of a mid-word hit, and still matches a department', async () => {
    render(<Single />);
    await screen.findByPlaceholderText('Search people');
    fireEvent.focus(box());
    await screen.findByText('Charmi Desai');
    fireEvent.change(box(), { target: { value: 'sai' } });
    expect(names()).toEqual(['Sai Patel', 'Charmi Desai']);
    fireEvent.change(box(), { target: { value: 'finance' } });
    expect(names()).toEqual(['Charmi Desai']);
    // The meta and the role tag stay on the row.
    fireEvent.change(box(), { target: { value: 'zed' } });
    expect(screen.getByText(/Director, Operations/)).toBeTruthy();
    expect(screen.getByText('Manager')).toBeTruthy();
  });

  it('managers lead only while nothing is typed', async () => {
    render(<Single preferManagers />);
    fireEvent.focus(box());
    await screen.findByText('Zed Boss');
    expect(names()[0]).toBe('Zed Boss');
    fireEvent.change(box(), { target: { value: 'person 0' } });
    expect(names()[0]).toBe('Person 00');
  });

  it('arrows and Enter pick, Esc closes', async () => {
    const onPick = vi.fn();
    render(<Single onPick={onPick} />);
    fireEvent.focus(box());
    await screen.findByText('Sai Patel');
    fireEvent.change(box(), { target: { value: 'person 1' } });
    expect(names().slice(0, 3)).toEqual(['Person 01', 'Person 10', 'Person 11']);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(document.querySelector('[data-nav-active]').textContent).toContain('Person 11');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('p11@x.com');
    expect(JSON.parse(localStorage.getItem('nexus:people-recent'))).toEqual(['p11@x.com']);
    fireEvent.click(screen.getByText('Person 11'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows Recent above All while nothing is typed, and hides it on a search', async () => {
    localStorage.setItem('nexus:people-recent', JSON.stringify(['p5@x.com']));
    render(<Single />);
    fireEvent.focus(box());
    await screen.findByText('Sai Patel');
    expect(captions()).toEqual(['Recent', 'All']);
    expect(names()[0]).toBe('Person 05');
    expect(within(screen.getByRole('listbox')).getAllByText('Person 05')).toHaveLength(2);
    fireEvent.change(box(), { target: { value: 'pers' } });
    expect(captions()).toEqual([]);
  });
});

describe('PeopleMultiPick', () => {
  function Multi() {
    const [v, setV] = useState([]);
    return <PeopleMultiPick value={v} onChange={setV} />;
  }

  it('Enter adds, keeps the menu open and clears the search; Recent leaves out who is chosen', async () => {
    localStorage.setItem('nexus:people-recent', JSON.stringify(['p2@x.com', 'p3@x.com']));
    render(<Multi />);
    const input = screen.getByPlaceholderText('Add people');
    fireEvent.focus(input);
    await screen.findByText('Sai Patel');
    expect(captions()).toEqual(['Recent', 'All']);
    fireEvent.keyDown(input, { key: 'Enter' });          // the top Recent row
    expect(screen.getByLabelText('Remove Person 02')).toBeTruthy();
    expect(input.value).toBe('');
    expect(names().filter((n) => n === 'Person 02')).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'sai' } });
    expect(names()).toEqual(['Sai Patel', 'Charmi Desai']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Remove Sai Patel')).toBeTruthy();
    expect(input.value).toBe('');
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
