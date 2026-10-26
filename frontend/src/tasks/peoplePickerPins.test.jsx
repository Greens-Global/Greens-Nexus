import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PersonMultiSelect, PersonSelect } from './components';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// What the Tasks people pickers already do, pinned before the people-finder
// pass (Neil, Oct 25 2026: "take the best from both ... make sure we don't go
// in reverse"). Keyboard, Frequent, Teams and phone behavior have their own
// files (pickerKeyboard, frequentPeople, teamPicks, personPickerMobile).

const people = [
  { email: 'charmi@x.com', name: 'Charmi Desai' },
  { email: 'sai@x.com', name: 'Sai Malladi' },
  { email: 'pat@partner.com', name: 'Pat Partner', external: true },
  { email: 'amy@x.com', name: 'Amy Wilson' },
];

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  try { localStorage.clear(); } catch { /* none */ }
});

const searchBox = () => screen.getByPlaceholderText('Search people…');
const rowTexts = () => screen.getAllByRole('option').map((o) => o.textContent);

function Multi({ initial = [] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PersonMultiSelect value={value} onChange={setValue} people={people} placeholder="Assign to…" />
      <div data-testid="value">{value.join(',')}</div>
    </>
  );
}

describe('Tasks people pickers (pinned)', () => {
  it('ranks a first-name match ahead of a mid-name one', () => {
    render(<PersonSelect value={null} onChange={vi.fn()} people={people} />);
    fireEvent.click(screen.getByText('Unassigned'));
    fireEvent.change(searchBox(), { target: { value: 'sai' } });
    const rows = rowTexts();
    expect(rows[0]).toContain('Sai Malladi');
    expect(rows[1]).toContain('Charmi Desai');
  });

  it('the Unassigned row clears the field', () => {
    const onChange = vi.fn();
    render(<PersonSelect value="sai@x.com" onChange={onChange} people={people} />);
    fireEvent.click(screen.getByText('Sai Malladi'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Unassigned'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('the add-button variant has no Unassigned row', () => {
    render(<PersonSelect value={null} onChange={vi.fn()} people={people} addButton placeholder="Add member…" />);
    fireEvent.click(screen.getByText('Add member…'));
    expect(within(screen.getByRole('listbox')).queryByText('Unassigned')).not.toBeInTheDocument();
  });

  it('shows a value missing from the directory by a name made from the email', () => {
    render(<PersonSelect value="jane.doe@x.com" onChange={vi.fn()} people={people} />);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('checks the people already picked, and tags externals', () => {
    render(<Multi initial={['amy@x.com']} />);
    fireEvent.click(screen.getByTitle('Add people'));
    const amy = screen.getAllByRole('option').find((o) => o.textContent.includes('Amy Wilson'));
    expect(amy.querySelector('svg')).not.toBeNull();
    const pat = screen.getAllByRole('option').find((o) => o.textContent.includes('Pat Partner'));
    expect(pat.textContent).toMatch(/external/i);
  });

  it('lists everyone A-Z before anything is typed', () => {
    render(<Multi />);
    fireEvent.click(screen.getByText('Assign to…'));
    const names = ['Amy Wilson', 'Charmi Desai', 'Pat Partner', 'Sai Malladi'];
    expect(rowTexts().map((t) => names.find((n) => t.includes(n)))).toEqual(names);
  });

  it('Backspace takes the last person off, on the closed field and in an empty search', () => {
    render(<Multi initial={['amy@x.com', 'sai@x.com', 'charmi@x.com']} />);
    const field = screen.getAllByRole('button').find((b) => b.textContent.includes('Amy Wilson'));
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(screen.getByTestId('value').textContent).toBe('amy@x.com,sai@x.com');
    fireEvent.click(screen.getByTitle('Add people'));
    fireEvent.keyDown(searchBox(), { key: 'Backspace' });
    expect(screen.getByTestId('value').textContent).toBe('amy@x.com');
  });

  it('Collaborators keeps Frequent and Teams (approved and personal) together, and saves a team', async () => {
    const teams = [
      { id: 't-hr', name: 'HR Team', approvalStatus: 'approved', memberIds: ['charmi@x.com', 'amy@x.com'] },
      { id: 't-mine', name: 'My Crew', approvalStatus: 'personal', memberIds: ['sai@x.com'] },
    ];
    const onSaveTeam = vi.fn(() => Promise.resolve());
    function Collab() {
      const [value, setValue] = useState(['amy@x.com', 'sai@x.com']);
      return <PersonMultiSelect value={value} onChange={setValue} people={people} frequent={['sai@x.com']} teams={teams} onSaveTeam={onSaveTeam} placeholder="Add collaborators…" />;
    }
    render(<Collab />);
    fireEvent.click(screen.getByTitle('Add people'));
    expect(screen.getByText('Teams')).toBeInTheDocument();
    expect(screen.getByTitle(/HR Team/)).toBeInTheDocument();
    expect(screen.getByTitle(/My Crew/).textContent).toContain('Personal');
    expect(screen.getByText('Frequent')).toBeInTheDocument();
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.getByText(/Save These 2 People as a Team/)).toBeInTheDocument();
  });

  it('Enter takes a team when the search matches only a team', () => {
    const teams = [{ id: 't-hr', name: 'Payroll Crew', approvalStatus: 'approved', memberIds: ['charmi@x.com', 'amy@x.com'] }];
    function Collab() {
      const [value, setValue] = useState([]);
      return (<><PersonMultiSelect value={value} onChange={setValue} people={people} teams={teams} placeholder="Add collaborators…" />
        <div data-testid="value">{value.join(',')}</div></>);
    }
    render(<Collab />);
    fireEvent.click(screen.getByText('Add collaborators…'));
    fireEvent.change(searchBox(), { target: { value: 'payroll' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('charmi@x.com,amy@x.com');
  });
});
