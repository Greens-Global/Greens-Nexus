import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mailbox export lives in the offboarding process only (Neil, Oct 22 2026):
// the Documents tab shows the RESULT of one, never a way to start one.

const latest = vi.fn();
const url = vi.fn();
const start = vi.fn();
vi.mock('../api', () => ({
  api: {
    getMailboxExport: (...a) => latest(...a),
    getExportStatus: vi.fn(),
    getExportUrl: (...a) => url(...a),
    startMailboxExport: (...a) => start(...a),
  },
}));

const { default: MailboxExportResult } = await import('./MailboxExportResult');

describe('MailboxExportResult', () => {
  beforeEach(() => { latest.mockReset(); url.mockReset(); start.mockReset(); });

  it('renders nothing when the person has no export', async () => {
    latest.mockResolvedValue(null);
    const { container } = render(<MailboxExportResult employeeId="e1" />);
    await waitFor(() => expect(latest).toHaveBeenCalledWith('e1'));
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a ready export offers Download .zip and nothing to start', async () => {
    latest.mockResolvedValue({ id: 'j1', status: 'done', message: '120 messages', updatedAt: '2026-10-22T18:00:00Z' });
    url.mockResolvedValue({ url: 'https://x/zip' });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MailboxExportResult employeeId="e1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Download \.zip/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://x/zip', '_blank', 'noopener'));
    expect(screen.getByText(/Ready · 120 messages · 10\/22\/2026/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('a failed export shows the reason, with no buttons', async () => {
    latest.mockResolvedValue({ id: 'j2', status: 'error', message: 'Mail.Read missing' });
    render(<MailboxExportResult employeeId="e1" />);
    expect(await screen.findByText('Failed · Mail.Read missing')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
