import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import ShortcutsPage from './ShortcutsPage';
import { allShortcuts } from '../lib/shortcutList';

// Help > Keyboard Shortcuts (11/13/2026): the one list, drawn in groups.
afterEach(() => cleanup());

describe('ShortcutsPage', () => {
  it('draws every group and every row of the list, with the keys in key caps', () => {
    render(<ShortcutsPage onBack={() => {}} mac={false} />);
    expect(screen.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeTruthy();
    for (const title of ['Everywhere', 'Tasks', 'Tickets', 'Lists Inside a Screen']) {
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem').length).toBe(allShortcuts({ mac: false }).length);
    const search = screen.getByText('Search Nexus').closest('[role="listitem"]');
    expect([...search.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl+K', '/']);
    expect(within(search).getByText('or')).toBeTruthy();
    // A list with no key of its own says where to click.
    expect(screen.getByText('The Notes shortcuts').closest('[role="listitem"]').textContent).toMatch(/keyboard button/);
  });

  it('reads Cmd on a Mac, and Back goes back', () => {
    const onBack = vi.fn();
    render(<ShortcutsPage onBack={onBack} mac />);
    const search = screen.getByText('Search Nexus').closest('[role="listitem"]');
    expect(search.querySelector('kbd').textContent).toBe('Cmd+K');
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
