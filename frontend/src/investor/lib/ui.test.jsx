import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Investor Relations' people fields (Deal Manager, Relationship Owner) are
// the Tasks people picker (Oct 25 2026): type to search, and the form still
// gets the email - '' when cleared - exactly as the old list gave it.

vi.mock('../../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('../../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

const { PeopleSelect } = await import('./ui');

const people = [
  { email: 'Amy.Adams@x.com', name: 'Amy Adams' },
  { email: 'ben.bell@x.com', name: 'Ben Bell' },
];

function Field({ onValue }) {
  const [v, setV] = useState('');
  return <PeopleSelect value={v} onChange={(x) => { setV(x); onValue(x); }} people={people} placeholder="Select a deal manager…" />;
}

describe('PeopleSelect', () => {
  it('searches and hands back the email, then an empty string when cleared', () => {
    const onValue = vi.fn();
    render(<Field onValue={onValue} />);
    fireEvent.click(screen.getByText('Select a deal manager…'));
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'be' } });
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Ben Bell'));
    expect(onValue).toHaveBeenLastCalledWith('ben.bell@x.com');
    fireEvent.click(screen.getByText('Ben Bell'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Not Assigned'));
    expect(onValue).toHaveBeenLastCalledWith('');
  });
});
