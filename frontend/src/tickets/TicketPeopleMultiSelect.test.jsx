import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TicketPeopleMultiSelect } from './TicketAtoms';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// A ticket's Collaborators picker works like the Tasks one (Oct 25 2026):
// first-name matches first, Up / Down / Enter, and the people picked lately
// as "Recent" when the field has no Frequent group. Rows keep name + email.

const names = ['Charmi Desai', 'Sai Malladi', 'Amy Wilson', 'Bob Brown', 'Cat Cole', 'Dan Diaz', 'Eve Evans',
  'Fay Ford', 'Gus Grant', 'Hal Hart', 'Ivy Irwin', 'Jon James', 'Kim Kerr', 'Lee Long'];
const options = names.map((n) => {
  const email = `${n.split(' ')[0].toLowerCase()}@x.com`;
  return { id: email, label: n, desc: email };
});

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  try { localStorage.clear(); } catch { /* none */ }
});

function Field({ frequent = null, onPicked = () => {} }) {
  const [value, setValue] = useState([]);
  return <TicketPeopleMultiSelect value={value} options={options} frequent={frequent}
    onChange={(v) => { setValue(v); onPicked(v); }} />;
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
const box = () => screen.getByPlaceholderText('Search people…');
const rowNames = () => screen.getAllByRole('option').map((o) => o.textContent);
const captions = () => ['Recent', 'Frequent', 'All'].filter((c) => screen.queryByText(c));

describe('Ticket Collaborators picker', () => {
  it('ranks a first-name match ahead of a last-name substring', () => {
    render(<Field />);
    open();
    fireEvent.change(box(), { target: { value: 'sai' } });
    expect(rowNames()[0]).toContain('Sai Malladi');
    expect(rowNames()[1]).toContain('Charmi Desai');
    // Still matches an email.
    fireEvent.change(box(), { target: { value: 'kim@' } });
    expect(rowNames()).toEqual([expect.stringContaining('Kim Kerr')]);
  });

  it('Enter takes the highlighted row; arrows move it', () => {
    const onPicked = vi.fn();
    render(<Field onPicked={onPicked} />);
    open();
    fireEvent.change(box(), { target: { value: 'sai' } });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onPicked).toHaveBeenLastCalledWith(['charmi@x.com']);
  });

  it('shows Recent when there is no Frequent group, and Frequent wins when there is', () => {
    const { unmount } = render(<Field />);
    open();
    expect(captions()).toEqual([]);
    fireEvent.change(box(), { target: { value: 'gus' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    unmount();

    const second = render(<Field />);
    open();
    expect(captions()).toEqual(['Recent', 'All']);
    expect(screen.getAllByText('Gus Grant')).toHaveLength(2);
    second.unmount();

    render(<Field frequent={['amy@x.com']} />);
    open();
    expect(captions()).toEqual(['Frequent', 'All']);
  });
});
