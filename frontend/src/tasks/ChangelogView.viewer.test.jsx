import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Reading What's New is every Nexus user's default; changing it is a
// permission (Neil, Oct 12 2026). A user with no Tasks or Tickets grant reads
// everything, comments included, and is offered nothing that would only 403.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myEmail: 'viewer@greensglobal.com', can: () => false, myGrantedModules: new Map() }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskChangelog.mockResolvedValue([{
    id: 'e1', title: 'Faster lists', description: 'Plain words.', type: 'New Feature', module: 'Tasks',
    status: 'Released', releasedAt: '2026-10-09T10:00:00Z', authorId: 'dev@greensglobal.com',
  }]);
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([{ id: 'c1', authorId: 'dev@greensglobal.com', body: 'Shipped today', createdAt: '2026-10-09T11:00:00Z' }]);
});

describe("What's New for a reader without edit permission", () => {
  it('shows every update but no Add, no Manage tab', async () => {
    render(<Changelog />);
    expect(await screen.findByText('Faster lists')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add New Update' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Manage/ })).toBeNull();
  });

  it('reads the comments, without a box to post one', async () => {
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: /View Full Details/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Comments/ }));
    expect(await screen.findByText('Shipped today')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
