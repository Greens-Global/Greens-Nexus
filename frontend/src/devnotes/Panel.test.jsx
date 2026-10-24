import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// The Build Mode panel (Oct 24 2026): Send To Claude Code is disabled with a
// hint while the collecting session is empty, enabled once an open pin is in.

let notes = [];
vi.mock('../api', () => ({
  api: {
    devNotesList: vi.fn((p) => Promise.resolve(p?.status === 'dismissed' ? [] : notes)),
    devNotesSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'Build Session 10/24/2026 9:00 AM', status: 'collecting', noteCount: notes.length, createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:00:00Z' }])),
    devNotesStats: vi.fn(() => Promise.resolve({ pins: { total: 4, open: 1, fixed: 1, done: 2 }, medianPinToPrHours: 2.5, reopenRate: null, firstClaimHitRate: 0.75, days: 30 })),
    devNotesDispatch: vi.fn(() => Promise.resolve({ notes: [] })),
    devNotesTokens: vi.fn(() => Promise.resolve([])),
  },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));

const Panel = (await import('./Panel')).default;

afterEach(() => { cleanup(); notes = []; });

const props = { open: true, tab: 'queue', onTab: vi.fn(), onClose: vi.fn(), settings: { sendInstantly: false, dispatchTarget: 'local', pinsOnLoad: true }, onSettings: vi.fn(), onOpenPin: vi.fn() };

describe('Panel', () => {
  it('Send To Claude Code is disabled with a hint when there is nothing to send', async () => {
    render(<Panel {...props} />);
    const btn = screen.getByRole('button', { name: /Send To Claude Code/ });
    expect(btn).toBeDisabled();
    await screen.findByText(/No pins yet/);
    expect(screen.getByText(/Your collecting session is empty/)).toBeTruthy();
    expect(btn).toBeDisabled();
  });

  it('an open pin in the collecting session enables the button and lists the pin under its session', async () => {
    notes = [{ id: 'p1', number: 1, kind: 'change', priority: 'blocking', status: 'open', comment: 'Make this bigger', sessionId: 's1', route: 'tasks', sub: 'home', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] }];
    render(<Panel {...props} />);
    await screen.findByText('Make this bigger');
    expect(screen.getByText('Build Session 10/24/2026 9:00 AM')).toBeTruthy();
    expect(screen.getByText('Blocking')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /Send To Claude Code/ })).not.toBeDisabled());
  });

  it('Sessions tab shows the Stats strip with a dash for a null rate', async () => {
    render(<Panel {...props} tab="sessions" />);
    await screen.findByText('Pin To PR (Median)');
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('First-Claim Hit Rate')).toBeTruthy();
    expect(screen.getByText('Reopen Rate').previousSibling.textContent).toBe('-');
  });

  it('Settings tab: the GitHub Issue target is disabled and the watcher one-liner is shown', async () => {
    render(<Panel {...props} tab="settings" />);
    expect(screen.getByRole('switch', { name: 'Send Instantly' })).toBeTruthy();
    const github = screen.getByLabelText(/GitHub Issue/);
    expect(github).toBeDisabled();
    expect(screen.getAllByText('python3 tools/build_notes/watch.py').length).toBeGreaterThan(0);
    await screen.findByRole('button', { name: /Mint Token/ });
  });
});
