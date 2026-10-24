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

  it('a held pin shows Waits For <Owner>, is not counted as ready to send, and alone leaves Send disabled', async () => {
    notes = [{ id: 'p2', number: 2, kind: 'bug', priority: 'normal', status: 'open', comment: 'Bell count is wrong', sessionId: 's1', route: 'inventory', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [], held: true, ownerEmail: 'visesh.lodha@greensglobal.com', ownerName: 'Visesh' }];
    render(<Panel {...props} myEmail="neil@greensglobal.com" />);
    await screen.findByText('Bell count is wrong');
    expect(screen.getByText('Waits For Visesh')).toBeTruthy();
    expect(screen.getByText(/Pin #2 waits for Visesh/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send To Claude Code/ })).toBeDisabled();
  });

  it('Send counts only unheld pins and names the held ones afterwards', async () => {
    const { api } = await import('../api');
    api.devNotesDispatch.mockResolvedValueOnce({ notes: [{ id: 'p1' }], held: [{ id: 'p2', number: 2, ownerName: 'Visesh' }] });
    const base = { kind: 'bug', priority: 'normal', status: 'open', sessionId: 's1', route: 'inventory', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
    notes = [{ ...base, id: 'p1', number: 1, comment: 'Ordinary pin' }, { ...base, id: 'p2', number: 2, comment: 'Held pin', held: true, ownerName: 'Visesh', ownerEmail: 'visesh.lodha@greensglobal.com' }];
    const store = await import('./store');
    render(<Panel {...props} myEmail="neil@greensglobal.com" />);
    await screen.findByText('Held pin');
    expect(screen.getByText(/1 of yours ready to send\./)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Send To Claude Code/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    btn.click();
    await waitFor(() => expect(store.store.get().toast?.text).toBe('Sent - Pin #2 waits for Visesh'));
  });

  it('Queue: my pins Ready To Check are counted up top and on their session; a click opens the first', async () => {
    const base = { kind: 'bug', priority: 'normal', sessionId: 's1', route: 'inventory', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
    notes = [
      { ...base, id: 'a', number: 1, status: 'pr_open', readyToCheck: true, preview: { url: 'http://localhost:5180/' }, comment: 'One' },
      { ...base, id: 'b', number: 2, status: 'pr_open', readyToCheck: false, previewVerdict: 'accepted', comment: 'Two' },
      { ...base, id: 'c', number: 3, status: 'pr_open', readyToCheck: true, createdBy: 'sagar@greensglobal.com', comment: 'Three' },
    ];
    const onOpenPin = vi.fn();
    render(<Panel {...props} onOpenPin={onOpenPin} myEmail="neil@greensglobal.com" />);
    const line = await screen.findByTestId('bm-ready-count');
    expect(line.textContent).toContain('1 Ready To Check');
    expect(line.textContent).toContain('#1');
    expect(screen.getByText('2 Ready To Check')).toBeTruthy();       // the session group counts everyone's
    expect(screen.getByText('PR Open - Checked')).toBeTruthy();
    line.click();
    expect(onOpenPin).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('Send with only held pins left shows the server detail', async () => {
    const { api } = await import('../api');
    api.devNotesDispatch.mockRejectedValueOnce(new Error('No open pins to send - Pin #2 waits for Visesh'));
    notes = [{ id: 'p1', number: 1, kind: 'bug', priority: 'normal', status: 'open', comment: 'Ordinary', sessionId: 's1', route: 'tasks', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] }];
    const store = await import('./store');
    render(<Panel {...props} myEmail="neil@greensglobal.com" />);
    await screen.findByText('Ordinary');
    const btn = screen.getByRole('button', { name: /Send To Claude Code/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    btn.click();
    await waitFor(() => expect(store.store.get().toast?.text).toBe('No open pins to send - Pin #2 waits for Visesh'));
  });

  it('Sessions tab: per session, how many are Ready To Check and Waiting For Owner', async () => {
    const base = { kind: 'bug', priority: 'normal', sessionId: 's1', route: 'inventory', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
    notes = [
      { ...base, id: 'a', number: 1, status: 'pr_open', readyToCheck: true, preview: { url: 'http://localhost:5180/' } },
      { ...base, id: 'b', number: 2, status: 'pr_open', readyToCheck: true, preview: { url: 'http://localhost:5180/' } },
      { ...base, id: 'c', number: 3, status: 'open', held: true, ownerName: 'Visesh' },
      { ...base, id: 'd', number: 4, status: 'open' },
    ];
    render(<Panel {...props} tab="sessions" />);
    await screen.findByText('2 Ready To Check');
    expect(screen.getByText('1 Waiting For Owner')).toBeTruthy();
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
