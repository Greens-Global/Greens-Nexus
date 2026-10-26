import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// What's New comment @mentions rank like every people picker (Oct 25 2026):
// a first-name match ahead of a last-name substring, still six at most.

const names = ['Charmi Desai', 'Sai Malladi', 'Isai Ortiz', 'Saida Khan', 'Sain Bell', 'Saito Ono', 'Saige Day', 'Saim Ali'];
const PEOPLE = names.map((n) => ({ email: `${n.split(' ')[0].toLowerCase()}@x.com`, name: n }));
vi.mock('../api', () => ({
  api: {
    getPeopleDirectory: vi.fn(() => Promise.resolve(PEOPLE)),
    getTaskChangelogComments: vi.fn(() => Promise.resolve([])),
    addTaskChangelogComment: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ MODULES: [], useRole: () => ({ myEmail: 'me@x.com', can: () => true, myGrantedModules: new Map() }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

const { CommentThread } = await import('./changelogExtras');

describe('What\'s New @mention', () => {
  it('ranks first-name matches first and caps the list at six', async () => {
    render(<CommentThread entryId="e1" canComment nameOf={(e) => e} />);
    await screen.findByText(/No comments yet/);
    // Let the directory load.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.change(screen.getByLabelText('Add a comment'), { target: { value: '@sai' } });
    const rows = (await screen.findAllByRole('option')).map((o) => o.lastChild.textContent);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 2)).toEqual(['Sai Malladi', 'Saida Khan']);
    expect(rows).not.toContain('Charmi Desai');
    expect(rows).not.toContain('Isai Ortiz');
  });
});
