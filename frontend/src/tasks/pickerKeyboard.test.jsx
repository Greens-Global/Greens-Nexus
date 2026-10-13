import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonMultiSelect, PersonSelect } from './components';
import ProjectPicker from './ProjectPicker';
import RichDescription from './RichDescription';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// Filling in Create a Task from the keyboard (Sagar, Oct 13 2026): typing "sa"
// into Assignee filtered the list but highlighted nothing, so what Enter would
// take was invisible, the arrow keys did nothing, and Tab left the form. The
// description toolbar's buttons were a Tab stop each. See lib/listNav.js.

const people = [
  { email: 'aarav@x.com', name: 'Aarav Desai' },
  { email: 'sagar@x.com', name: 'Sagar Kumar Shoundik' },
  { email: 'sahil@x.com', name: 'Sahil Desai' },
  { email: 'sai@x.com', name: 'Sai Malladi' },
];

beforeEach(() => {
  // Desktop: a mouse, a wide window - the menus autofocus their search box.
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const highlighted = () => document.querySelector('[data-nav-active]')?.textContent || '';

function Assignees({ initial = [] }) {
  const [value, setValue] = useState(initial);
  return (
    <div role="dialog">
      <PersonMultiSelect value={value} onChange={setValue} people={people} placeholder="Assign to…" />
      <div data-testid="value">{value.join(',')}</div>
      <input aria-label="Next field" />
    </div>
  );
}

const openAssignee = () => fireEvent.click(screen.getByText('Assign to…'));
const searchBox = () => screen.getByPlaceholderText('Search people…');

describe('people picker keyboard', () => {
  it('highlights the person Enter will take as you type', () => {
    render(<Assignees />);
    openAssignee();
    fireEvent.change(searchBox(), { target: { value: 'sa' } });
    expect(highlighted()).toContain('Sagar Kumar Shoundik');
  });

  it('moves the highlight with the arrow keys, and Enter takes it', () => {
    render(<Assignees />);
    openAssignee();
    fireEvent.change(searchBox(), { target: { value: 'sa' } });
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(highlighted()).toContain('Sahil Desai');
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(highlighted()).toContain('Sai Malladi');
    fireEvent.keyDown(searchBox(), { key: 'ArrowUp' });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('sahil@x.com');
  });

  it('Tab takes the highlighted person and moves on to the next field', () => {
    render(<Assignees />);
    openAssignee();
    fireEvent.change(searchBox(), { target: { value: 'sa' } });
    fireEvent.keyDown(searchBox(), { key: 'Tab' });
    expect(screen.getByTestId('value').textContent).toBe('sagar@x.com');
    expect(screen.queryByPlaceholderText('Search people…')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Next field'));
  });

  it('Tab with nothing typed adds no one', () => {
    render(<Assignees />);
    openAssignee();
    fireEvent.keyDown(searchBox(), { key: 'Tab' });
    expect(screen.getByTestId('value').textContent).toBe('');
    expect(document.activeElement).toBe(screen.getByLabelText('Next field'));
  });

  it('Tab never takes off someone already assigned', () => {
    render(<Assignees initial={['sagar@x.com']} />);
    fireEvent.click(screen.getByText('Sagar Kumar Shoundik'));
    fireEvent.change(searchBox(), { target: { value: 'sag' } });
    fireEvent.keyDown(searchBox(), { key: 'Tab' });
    expect(screen.getByTestId('value').textContent).toBe('sagar@x.com');
  });

  it('typing on the closed field opens it with the letter already searched', () => {
    render(<Assignees />);
    const trigger = screen.getByText('Assign to…').closest('button');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 's' });
    expect(searchBox().value).toBe('s');
    expect(highlighted()).toContain('Sagar Kumar Shoundik');
  });

  it('the chips are not Tab stops of their own', () => {
    render(<Assignees initial={['sagar@x.com', 'sahil@x.com']} />);
    expect(screen.getByTitle('Remove Sagar Kumar Shoundik').tabIndex).toBe(-1);
    expect(screen.getByTitle('Remove Sahil Desai').tabIndex).toBe(-1);
  });

  it('Escape closes the menu and gives focus back to the field', () => {
    render(<Assignees />);
    openAssignee();
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Search people…')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('Assign to…').closest('button'));
  });

  it('a single picker opens on the current person, and a search that matches nobody never clears it', () => {
    const onChange = vi.fn();
    render(<PersonSelect value="sahil@x.com" onChange={onChange} people={people} />);
    fireEvent.click(screen.getByText('Sahil Desai'));
    expect(highlighted()).toContain('Sahil Desai');
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('project picker keyboard', () => {
  const projects = [
    { id: 'p1', name: 'Menifee' },
    { id: 'p2', name: 'Mammoth' },
    { id: 'p3', name: 'GSE Development' },
  ];
  it('puts a name that starts with the search first, arrows through the rest, Enter takes it', () => {
    const onChange = vi.fn();
    render(<ProjectPicker projects={projects} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    const box = screen.getByPlaceholderText('Search projects');
    // "me" is inside "GSE Development" too, which sorts first alphabetically.
    fireEvent.change(box, { target: { value: 'me' } });
    expect(highlighted()).toContain('Menifee');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(highlighted()).toContain('GSE Development');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('p3');
  });
});

describe('description toolbar', () => {
  it('keeps its buttons out of the Tab order', async () => {
    render(<RichDescription value="" onChange={() => {}} />);
    const bold = await screen.findByLabelText('Bold');
    expect(bold.tabIndex).toBe(-1);
    expect(screen.getByLabelText('Rephrase with AI').tabIndex).toBe(-1);
  });
});
