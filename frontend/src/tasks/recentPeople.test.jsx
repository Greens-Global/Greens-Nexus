import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PersonMultiSelect, PersonSelect } from './components';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// "Recent" in the Tasks people pickers (Oct 25 2026): a field with no
// Frequent group shows the people picked lately first, the same way, on a
// list long enough to need it. Rows stay name-only.

const many = Array.from({ length: 16 }, (_, i) => ({ email: `p${i}@x.com`, name: `Person ${String(i).padStart(2, '0')}` }));
const few = many.slice(0, 5);

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  try { localStorage.clear(); } catch { /* none */ }
});

const searchBox = () => screen.getByPlaceholderText('Search people…');
const captions = () => ['Recent', 'Frequent', 'All'].filter((c) => screen.queryByText(c));
const setRecent = (emails) => localStorage.setItem('nexus:people-recent', JSON.stringify(emails));

function Multi({ people = many, frequent = null }) {
  const [value, setValue] = useState([]);
  return <PersonMultiSelect value={value} onChange={setValue} people={people} frequent={frequent} placeholder="Assign to…" />;
}

describe('Recent in the Tasks people pickers', () => {
  it('a single picker shows nothing extra until someone was picked, then Recent above All', () => {
    const { unmount } = render(<PersonSelect value={null} onChange={vi.fn()} people={many} />);
    fireEvent.click(screen.getByText('Unassigned'));
    expect(captions()).toEqual([]);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Person 07'));
    unmount();
    render(<PersonSelect value={null} onChange={vi.fn()} people={many} />);
    fireEvent.click(screen.getByText('Unassigned'));
    expect(captions()).toEqual(['Recent', 'All']);
    expect(within(screen.getByRole('listbox')).getAllByText('Person 07')).toHaveLength(2);
    // Keyboard order is display order: Unassigned, then Recent.
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(document.querySelector('[data-nav-active]').textContent).toContain('Person 07');
  });

  it('a search hides Recent and is one flat list', () => {
    setRecent(['p7@x.com']);
    render(<PersonSelect value={null} onChange={vi.fn()} people={many} />);
    fireEvent.click(screen.getByText('Unassigned'));
    fireEvent.change(searchBox(), { target: { value: 'person 0' } });
    expect(captions()).toEqual([]);
  });

  it('no Recent on a short list', () => {
    setRecent(['p1@x.com']);
    render(<PersonSelect value={null} onChange={vi.fn()} people={few} />);
    fireEvent.click(screen.getByText('Unassigned'));
    expect(captions()).toEqual([]);
  });

  it('a multi picker shows Recent when it has no Frequent, and Frequent wins when it does', () => {
    setRecent(['p3@x.com']);
    const { unmount } = render(<Multi />);
    fireEvent.click(screen.getByText('Assign to…'));
    expect(captions()).toEqual(['Recent', 'All']);
    unmount();
    render(<Multi frequent={['p9@x.com']} />);
    fireEvent.click(screen.getByText('Assign to…'));
    expect(captions()).toEqual(['Frequent', 'All']);
  });

  it('adding someone remembers them as recent', () => {
    render(<Multi />);
    fireEvent.click(screen.getByText('Assign to…'));
    fireEvent.change(searchBox(), { target: { value: 'person 12' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(JSON.parse(localStorage.getItem('nexus:people-recent'))).toEqual(['p12@x.com']);
  });
});
