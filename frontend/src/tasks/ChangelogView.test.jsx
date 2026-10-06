import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// What's New > Manage shows whether automatic drafting is healthy. It used to
// fail silently (a model Anthropic stopped serving, Oct 2026), so the review
// queue just stopped filling and looked like a few quiet weeks.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(),
    getTaskChangelogAutoStatus: vi.fn(),
    getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(),
    markTaskChangelogSeen: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myEmail: 'admin@greensglobal.com', can: () => true }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';

const healthy = {
  enabled: true, branch: 'dev', model: 'claude-opus-5', nextRunAt: '2026-10-08T10:00:00Z',
  lastRunAt: '2026-10-07T10:00:00Z', lastCreated: 2, lastReason: 'merge', lastError: '', lastErrorAt: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskChangelog.mockResolvedValue([]);
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
});

async function openManage() {
  render(<Changelog onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Manage/ }));
}

describe("What's New automatic drafting status", () => {
  it('shows the last run and how many drafts it made', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue(healthy);
    await openManage();
    expect(await screen.findByText(/Automatic drafting last ran .* \(2 drafted\)/)).toBeTruthy();
  });

  it('says plainly when drafting is failing, and why', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue({
      ...healthy, lastError: 'Claude could not draft the update: HTTP 404: model: claude-opus-4-8', lastErrorAt: '2026-10-07T09:00:00Z',
    });
    await openManage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Automatic drafting failed');
    expect(alert.textContent).toContain('claude-opus-4-8');
    expect(alert.textContent).toContain('Next try');
  });
});
