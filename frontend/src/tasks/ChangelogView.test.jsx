import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// What's New > Manage shows whether automatic publishing is healthy. It used to
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

describe("What's New automatic publishing status", () => {
  it('shows the last run and how many updates it published', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue(healthy);
    await openManage();
    expect(await screen.findByText(/Automatic publishing last ran .* \(2 published\)/)).toBeTruthy();
  });

  it('says plainly when drafting is failing, and why', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue({
      ...healthy, lastError: 'Could not read merged pull requests: GitHub /commits/dev - HTTP 401', lastErrorAt: '2026-10-07T09:00:00Z',
    });
    await openManage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Automatic publishing failed');
    expect(alert.textContent).toContain('HTTP 401');
    expect(alert.textContent).toContain('Next try');
  });

  it('a failed Check for Updates shows the reason in red and refreshes the status line', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue(healthy);
    api.generateTaskChangelog.mockRejectedValue(new Error('Could not read merged pull requests: GITHUB_TOKEN is not set on this server.'));
    await openManage();
    await screen.findByText(/Automatic publishing last ran/);
    fireEvent.click(screen.getByRole('button', { name: /Check for Updates/ }));
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('GITHUB_TOKEN');
    expect(toast.style.background).not.toBe('');
    await waitFor(() => expect(api.getTaskChangelogAutoStatus).toHaveBeenCalledTimes(2));
  });

  it('names the GitHub developers of a PR update, not whoever published it', async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue(healthy);
    api.getTaskChangelog.mockResolvedValue([{
      id: 'e1', title: 'Exempt People Never See the Clock', description: 'Plain words.', type: 'Bug Fix',
      module: 'Workday', status: 'Released', origin: 'pr', releasedAt: '2026-10-09T10:00:00Z', authorId: '',
      developers: [{ login: 'neilkadakia', name: 'Neil Kadakia', url: 'https://github.com/neilkadakia' },
        { login: 'pranshuup', name: 'pranshuup', url: 'https://github.com/pranshuup' }],
    }]);
    render(<Changelog onClose={() => {}} />);
    expect(await screen.findByText('Neil Kadakia, pranshuup')).toBeTruthy();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it("What's New shows the whole latest release day, so a hand-written note isn't pushed off", async () => {
    const at = (h, day = 9) => new Date(2026, 9, day, h, 0).toISOString();
    api.getTaskChangelog.mockResolvedValue([
      { id: 'a', title: 'Tickets Module Live', description: 'Manual.', type: 'New Feature', module: 'Tickets', status: 'Released', releasedAt: at(9) },
      { id: 'b', title: 'Ledger Operators', description: 'PR.', type: 'Bug Fix', module: 'Accounting', status: 'Released', origin: 'pr', releasedAt: at(15) },
      { id: 'c', title: 'Older Change', description: 'Old.', type: 'Improvement', module: 'HR', status: 'Released', releasedAt: at(10, 7) },
    ]);
    render(<Changelog onClose={() => {}} />);
    expect(await screen.findByText('Ledger Operators')).toBeTruthy();
    expect(screen.getByText('Tickets Module Live')).toBeTruthy();
    expect(screen.queryByText('Older Change')).toBeNull();
    expect(screen.getByText('2 updates')).toBeTruthy();
  });

  it("says when an update went out in the pull request's own words", async () => {
    api.getTaskChangelogAutoStatus.mockResolvedValue({ ...healthy, polishNote: 'HTTP 400: Your credit balance is too low' });
    await openManage();
    expect(await screen.findByText(/own wording - AI rewording unavailable: HTTP 400/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();          // a note, not a failure
  });
});
