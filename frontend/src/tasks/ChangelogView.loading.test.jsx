import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// What's New while it loads (Neil, 11/05/2026): a skeleton like every other
// screen, never "No updates published yet." before the feed has answered;
// a load that fails says so with Retry instead of reading as empty.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  MODULES: [{ id: 'tasks', label: 'Tasks' }],
  useRole: () => ({ myEmail: 'viewer@greensglobal.com', can: () => false, myGrantedModules: new Map() }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';

const ENTRY = {
  id: 'e1', title: 'Faster lists', description: 'Plain words.', type: 'New Feature', module: 'Tasks',
  status: 'Released', releasedAt: '2026-10-09T10:00:00Z', authorId: 'dev@greensglobal.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
});

describe("What's New loading", () => {
  it('shows the skeleton, not the empty line, until the feed answers', async () => {
    let answer;
    api.getTaskChangelog.mockReturnValue(new Promise((r) => { answer = r; }));
    const { container } = render(<Changelog />);
    expect(container.querySelector('[data-whats-new-skeleton]')).toBeTruthy();
    expect(screen.queryByText('No updates published yet.')).toBeNull();
    answer([ENTRY]);
    expect(await screen.findByText('Faster lists')).toBeTruthy();
    expect(container.querySelector('[data-whats-new-skeleton]')).toBeNull();
  });

  it('says the empty line only once the feed is really empty', async () => {
    api.getTaskChangelog.mockResolvedValue([]);
    render(<Changelog />);
    expect(await screen.findByText('No updates published yet.')).toBeTruthy();
  });

  it('a failed load offers Retry and loads on it', async () => {
    api.getTaskChangelog.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce([ENTRY]);
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Faster lists')).toBeTruthy();
    expect(screen.queryByText('Network down')).toBeNull();
  });
});
