import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Add Members on the schedule works like every people picker (Oct 25 2026):
// first-name matches first, and while nothing is typed the people picked
// lately come first under "Recent" (a list long enough to need it).

const names = ['Charmi Desai', 'Sai Malladi', 'Amy Wilson', 'Bob Brown', 'Cat Cole', 'Dan Diaz', 'Eve Evans',
  'Fay Ford', 'Gus Grant', 'Hal Hart', 'Ivy Irwin', 'Jon James', 'Kim Kerr', 'Lee Long'];
const PEOPLE = names.map((n) => ({ email: `${n.split(' ')[0].toLowerCase()}@x.com`, name: n }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve(PEOPLE) } }));

const { AddMembersModal } = await import('./ShiftTeams');

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

const team = { id: 'g1', name: 'Yard', members: ['lee@x.com'] };
const labels = () => [...document.querySelectorAll('input[type="checkbox"]')].map((c) => c.getAttribute('aria-label'));

describe('Add Members', () => {
  it('ranks a first-name match ahead of a last-name substring', async () => {
    render(<AddMembersModal team={team} onAdd={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText('Add Sai Malladi');
    fireEvent.change(screen.getByLabelText('Search people to add'), { target: { value: 'sai' } });
    expect(labels()).toEqual(['Add Sai Malladi', 'Add Charmi Desai']);
  });

  it('shows Recent above All while nothing is typed, and notes a ticked person', async () => {
    const first = render(<AddMembersModal team={team} onAdd={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText('Add Gus Grant');
    expect(screen.queryByText('Recent')).toBeNull();
    fireEvent.click(screen.getByLabelText('Add Gus Grant'));
    first.unmount();

    const onAdd = vi.fn();
    render(<AddMembersModal team={team} onAdd={onAdd} onClose={vi.fn()} />);
    await screen.findByText('Recent');
    expect(screen.getByText('All')).toBeTruthy();
    expect(labels()[0]).toBe('Add Gus Grant');
    fireEvent.change(screen.getByLabelText('Search people to add'), { target: { value: 'g' } });
    expect(screen.queryByText('Recent')).toBeNull();
    fireEvent.click(screen.getByLabelText('Add Gus Grant'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith(['gus@x.com']);
  });
});
