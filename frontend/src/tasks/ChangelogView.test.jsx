import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// What's New > Manage shows whether automatic drafting is healthy. It used to
// fail silently (the Anthropic account ran out of credit, Jul-Oct 2026), so
// the review queue just stopped filling and looked like a few quiet months.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(),
    getTaskChangelogAutoStatus: vi.fn(),
    generateTaskChangelog: vi.fn(),
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

  it('a failed Generate from git shows the reason in red and refreshes the status line', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue(healthy);
    api.generateTaskChangelog.mockRejectedValue(new Error('Claude could not draft the update: HTTP 400: Your credit balance is too low'));
    await openManage();
    await screen.findByText(/Automatic drafting last ran/);
    fireEvent.click(screen.getByRole('button', { name: /Generate from git/ }));
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('credit balance is too low');
    expect(toast.style.background).not.toBe('');
    await waitFor(() => expect(api.getTaskChangelogAutoStatus).toHaveBeenCalledTimes(2));
  });
});
