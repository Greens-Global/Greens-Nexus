// The bulk-action bar's "Assign…" and "Move To…" run on this. Both were native
// <select>s, which are unusable at the ~150 people / ~90 projects a real
// workspace carries - you cannot type into one.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchSelect } from './components';

const OPTIONS = [
  { id: '-', label: 'Unassigned' },
  { id: 'a@x.com', label: 'Aarav Mehta', keywords: 'a@x.com' },
  { id: 'c@x.com', label: 'Charmi Desai', keywords: 'c@x.com' },
  { id: 'd@x.com', label: 'Dean Wells', keywords: 'd@x.com' },
];

const open = () => fireEvent.click(screen.getByText('Assign…'));
const type = (v) => fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: v } });

function setup(onPick = vi.fn()) {
  render(
    <SearchSelect options={OPTIONS} onPick={onPick} placeholder="Assign…" searchPlaceholder="Search people…" />,
  );
  return onPick;
}

describe('SearchSelect', () => {
  it('shows every option before anything is typed', () => {
    setup();
    open();
    OPTIONS.forEach((o) => expect(screen.getByText(o.label)).toBeTruthy());
  });

  it('filters as you type', () => {
    setup();
    open();
    type('char');
    expect(screen.getByText('Charmi Desai')).toBeTruthy();
    expect(screen.queryByText('Dean Wells')).toBeNull();
  });

  it('matches on keywords that are never displayed, like an email', () => {
    setup();
    open();
    type('d@x.com');
    expect(screen.getByText('Dean Wells')).toBeTruthy();
    expect(screen.queryByText('Charmi Desai')).toBeNull();
  });

  it('ignores case and surrounding whitespace', () => {
    setup();
    open();
    type('  AARAV  ');
    expect(screen.getByText('Aarav Mehta')).toBeTruthy();
  });

  it('says so when nothing matches, rather than showing an empty menu', () => {
    setup();
    open();
    type('zzzz');
    expect(screen.getByText(/No matches for/)).toBeTruthy();
  });

  it('reports the picked id and closes', () => {
    const onPick = setup();
    open();
    fireEvent.click(screen.getByText('Charmi Desai'));
    expect(onPick).toHaveBeenCalledWith('c@x.com');
    expect(screen.queryByText('Dean Wells')).toBeNull();
  });

  it('keeps showing its placeholder after a pick - it is a command, not a value', () => {
    setup();
    open();
    fireEvent.click(screen.getByText('Charmi Desai'));
    expect(screen.getByText('Assign…')).toBeTruthy();
  });

  it('clears the previous query when reopened', () => {
    setup();
    open();
    type('char');
    fireEvent.click(screen.getByText('Charmi Desai'));
    open();
    expect(screen.getByText('Dean Wells')).toBeTruthy();
  });

  it('still offers the sentinel option, so "Unassigned" stays reachable', () => {
    const onPick = setup();
    open();
    fireEvent.click(screen.getByText('Unassigned'));
    expect(onPick).toHaveBeenCalledWith('-');
  });

  it('explains an empty list instead of rendering a blank menu', () => {
    render(
      <SearchSelect options={[]} onPick={vi.fn()} placeholder="Move To…"
        emptyText="No other projects to move into." />,
    );
    fireEvent.click(screen.getByText('Move To…'));
    expect(screen.getByText('No other projects to move into.')).toBeTruthy();
  });
});
