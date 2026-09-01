import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonMultiSelect } from './components';

// Avatar's hover card reaches for RoleContext, which this unit test has no
// reason to stand up - the picker itself is what's under test.
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// The assignee/collaborator menus on a phone are a panel ON TOP of the form, so
// leaving one open after a pick hides the field it just wrote to (Sagar, Sept 1
// 2026). Picking a name closes it there; on desktop the menu sits beside the
// field and stays open, because adding three people in a row is the point of a
// multi-select.

const people = [
  { email: 'pragya@greensglobal.com', name: 'Pragya Nautiyal' },
  { email: 'pranshu@greensglobal.com', name: 'Pranshu Pandey' },
];

function setViewport(isMobile) {
  globalThis.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

function Harness() {
  const [value, setValue] = useState([]);
  return <PersonMultiSelect value={value} onChange={setValue} people={people} placeholder="Unassigned" />;
}

// The menu is open when the search box it owns is on screen.
const menuOpen = () => !!screen.queryByPlaceholderText('Search people…');

describe('PersonMultiSelect menu dismissal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('closes after adding a name on a phone', () => {
    setViewport(true);
    render(<Harness />);
    fireEvent.click(screen.getByText('Unassigned'));
    expect(menuOpen()).toBe(true);
    fireEvent.click(screen.getByText('Pranshu Pandey'));
    expect(menuOpen()).toBe(false);
    // and the pick actually landed - the chip is on the trigger
    expect(screen.getByTitle('Remove Pranshu Pandey')).toBeInTheDocument();
  });

  it('stays open after adding a name on desktop, with the query reset', () => {
    setViewport(false);
    render(<Harness />);
    fireEvent.click(screen.getByText('Unassigned'));
    const box = screen.getByPlaceholderText('Search people…');
    fireEvent.change(box, { target: { value: 'Pra' } });
    fireEvent.click(screen.getByText('Pranshu Pandey'));
    expect(menuOpen()).toBe(true);
    // A spent query would leave the next name filtered out of the list.
    expect(screen.getByPlaceholderText('Search people…')).toHaveValue('');
    expect(screen.getByText('Pragya Nautiyal')).toBeInTheDocument();
  });

  it('stays open when a phone pick REMOVES someone', () => {
    setViewport(true);
    render(<Harness />);
    fireEvent.click(screen.getByText('Unassigned'));
    fireEvent.click(screen.getByText('Pranshu Pandey'));   // add - closes
    fireEvent.click(screen.getByTitle('Add people'));      // reopen
    fireEvent.click(screen.getAllByText('Pranshu Pandey')[1]); // the menu row
    expect(menuOpen()).toBe(true);
  });
});
