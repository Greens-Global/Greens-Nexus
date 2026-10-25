import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PersonSelect, PersonDot, SearchSelect } from './components';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// The shared pieces the people-picker pass leans on (Oct 25 2026): PersonSelect
// for a required field or a differently named "none" row, SearchSelect's
// first-letters-first order, and PersonDot's search, keyboard and Recent.

const people = [
  { email: 'charmi@x.com', name: 'Charmi Desai' },
  { email: 'sai@x.com', name: 'Sai Malladi' },
  { email: 'amy@x.com', name: 'Amy Wilson' },
];
const many = [...people, ...Array.from({ length: 12 }, (_, i) => ({ email: `p${i}@x.com`, name: `Zed Person${i}` }))];

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  try { localStorage.clear(); } catch { /* none */ }
});

const highlighted = () => document.querySelector('[data-nav-active]')?.textContent || '';

describe('PersonSelect options', () => {
  it('a required field has no clearing row', () => {
    render(<PersonSelect value={null} onChange={vi.fn()} people={people} allowNone={false} placeholder="Pick an approver" />);
    fireEvent.click(screen.getByText('Pick an approver'));
    expect(within(screen.getByRole('listbox')).queryByText('Unassigned')).toBeNull();
    expect(highlighted()).toContain('Charmi Desai');
  });

  it('names the clearing row and still clears', () => {
    const onChange = vi.fn();
    render(<PersonSelect value="sai@x.com" onChange={onChange} people={people} noneLabel="No Manager" />);
    fireEvent.click(screen.getByText('Sai Malladi'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('No Manager'));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('SearchSelect order', () => {
  it('puts a label that starts with the search first, then a word start, then the rest', () => {
    const options = [
      { id: 'c', label: 'Charmi Desai' },
      { id: 'm', label: 'Mosaic Team' },
      { id: 's', label: 'Sai Malladi' },
    ];
    render(<SearchSelect options={options} onPick={vi.fn()} placeholder="Assign…" searchPlaceholder="Search…" />);
    fireEvent.click(screen.getByText('Assign…'));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'sai' } });
    const rows = screen.getAllByRole('option').map((o) => o.textContent);
    expect(rows[0]).toContain('Sai Malladi');
    expect(rows.slice(1).join('|')).toMatch(/Charmi Desai|Mosaic Team/);
  });
});

describe('PersonDot', () => {
  it('ranks first names first and Enter takes the highlighted person', () => {
    const onChange = vi.fn();
    render(<PersonDot value="" people={people} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Choose a person'));
    const box = screen.getByPlaceholderText('Search people');
    fireEvent.change(box, { target: { value: 'sai' } });
    expect(highlighted()).toContain('Sai Malladi');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('sai@x.com');
  });

  it('shows Recent under Nobody once someone was picked, on a long list', () => {
    localStorage.setItem('nexus:people-recent', JSON.stringify(['amy@x.com']));
    render(<PersonDot value="" people={many} onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Choose a person'));
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getAllByText('Amy Wilson')).toHaveLength(2);
    fireEvent.keyDown(screen.getByPlaceholderText('Search people'), { key: 'ArrowDown' });
    expect(highlighted()).toContain('Amy Wilson');
  });

  it('Nobody clears the person', () => {
    const onChange = vi.fn();
    render(<PersonDot value="sai@x.com" people={people} nameOf={() => 'Sai Malladi'} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Sai Malladi - change'));
    fireEvent.click(screen.getByText('Nobody'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
