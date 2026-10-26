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
  API_BASE: '/api',          // relative, as in cookie mode: the connect line takes the server's address
}));

// These cover Send To Claude Code and the Settings tab, which are off while
// Send to Claude is on hold (meta.CLAUDE_SEND_ON) - tested here switched on,
// as they come back; Panel.claudeOff.test.jsx covers the panel as shipped.
vi.mock('./meta', async (importOriginal) => ({ ...(await importOriginal()), CLAUDE_SEND_ON: true }));

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
    api.devNotesDispatch.mockResolvedValueOnce({ notes: [{ id: 'p1' }, { id: 'p3' }], held: [{ id: 'p2', number: 4, ownerName: 'Visesh' }] });
    const base = { kind: 'bug', priority: 'normal', status: 'open', sessionId: 's1', route: 'inventory', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
    notes = [{ ...base, id: 'p1', number: 1, comment: 'Ordinary pin' }, { ...base, id: 'p2', number: 2, comment: 'Held pin', held: true, ownerName: 'Visesh', ownerEmail: 'visesh.lodha@greensglobal.com' }];
    const store = await import('./store');
    render(<Panel {...props} myEmail="neil@greensglobal.com" />);
    await screen.findByText('Held pin');
    expect(screen.getByText(/1 of yours ready to send\./)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Send To Claude Code/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    btn.click();
    await waitFor(() => expect(store.store.get().toast?.text).toBe('2 pins sent - Pin #4 waits for Visesh'));
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

  it('my open pins count whatever their session status (a sent session included)', async () => {
    const base = { kind: 'bug', priority: 'normal', status: 'open', route: 'tasks', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
    notes = [{ ...base, id: 'x1', number: 7, comment: 'In a sent session', sessionId: 'sent-1' }];
    const { api } = await import('../api');
    api.devNotesSessions.mockResolvedValueOnce([{ id: 'sent-1', title: 'Earlier Session', status: 'sent', noteCount: 1, createdBy: 'neil@greensglobal.com', createdAt: '2026-10-23T16:00:00Z' }]);
    render(<Panel {...props} myEmail="neil@greensglobal.com" />);
    await screen.findByText('In a sent session');
    expect(screen.getByText(/1 of yours ready to send\./)).toBeTruthy();
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

  it('the Queue says where your comments are, by module, and Save Report saves their session', async () => {
    const row = (id, number, route) => ({ id, number, kind: 'bug', priority: 'normal', status: 'open', comment: `Pin ${number}`, sessionId: 's1', route, sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] });
    notes = [row('p1', 1, 'tasks'), row('p2', 2, 'tasks'), row('p3', 3, 'tickets')];
    const { api } = await import('../api');
    api.devNotesSessionReport = vi.fn(() => Promise.resolve({ blob: new Blob(['<html></html>'], { type: 'text/html' }), filename: 'Build Session.html' }));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    render(<Panel {...props} />);
    const line = await screen.findByTestId('bm-by-module');
    expect(line.textContent).toMatch(/Tasks.* 2 · .*Tickets.* 1/);
    const save = screen.getByRole('button', { name: /Save Report/ });
    await waitFor(() => expect(save).not.toBeDisabled());
    save.click();
    await waitFor(() => expect(api.devNotesSessionReport).toHaveBeenCalledWith('s1'));
  });

  it('Settings has Show All Tools, off by default, remembered in this browser', async () => {
    localStorage.removeItem('nexus:build-mode:all-tools');
    render(<Panel {...props} tab="settings" />);
    const sw = screen.getByRole('switch', { name: 'Show All Tools' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show All Tools' }).getAttribute('aria-checked')).toBe('true'));
    expect(localStorage.getItem('nexus:build-mode:all-tools')).toBe('1');
  });
});

describe('Panel - Post To Teams (Oct 26 2026)', () => {
  const pinRow = { id: 'p1', number: 1, kind: 'bug', priority: 'normal', status: 'open', comment: 'Broken', sessionId: 's1', route: 'tasks', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };

  it('the first Post opens your chats and picking one posts there - nothing to Claude Code', async () => {
    notes = [pinRow];
    const { api } = await import('../api');
    api.timeMyChats = vi.fn(() => Promise.resolve({ chats: [{ id: '19:g', chatType: 'group', name: 'Nexus - Feedback and Bugs' }, { id: '19:p', chatType: 'oneOnOne', name: 'Neil Kadakia' }] }));
    api.devNotesTeamsPost = vi.fn(() => Promise.resolve({ posted: 1, chatName: 'Neil Kadakia' }));
    api.devNotesDispatch.mockClear();          // earlier tests in this file sent pins
    const onSettings = vi.fn(() => Promise.resolve());
    render(<Panel {...props} onSettings={onSettings} />);
    await screen.findByText('Broken');
    const post = screen.getByRole('button', { name: /^Post To Teams$/ });
    await waitFor(() => expect(post).not.toBeDisabled());
    post.click();
    (await screen.findByRole('option', { name: /Neil Kadakia/ })).click();
    await waitFor(() => expect(api.devNotesTeamsPost).toHaveBeenCalledWith({ teamsChatId: '19:p', teamsChatName: 'Neil Kadakia' }));
    expect(onSettings).toHaveBeenCalledWith({ teamsChatId: '19:p', teamsChatName: 'Neil Kadakia' });
    expect(api.devNotesDispatch).not.toHaveBeenCalled();
  });

  it('with a chat already picked, Post To Teams posts straight there', async () => {
    notes = [pinRow];
    const { api } = await import('../api');
    api.devNotesTeamsPost = vi.fn(() => Promise.resolve({ posted: 1, chatName: 'Dev chat' }));
    render(<Panel {...props} settings={{ ...props.settings, teamsChatId: '19:d', teamsChatName: 'Dev chat' }} />);
    await screen.findByText('Broken');
    const post = screen.getByRole('button', { name: 'Post To Teams - Dev chat' });
    await waitFor(() => expect(post).not.toBeDisabled());
    post.click();
    await waitFor(() => expect(api.devNotesTeamsPost).toHaveBeenCalledWith({ teamsChatId: '19:d', teamsChatName: 'Dev chat' }));
  });
});

describe('Panel - your own Claude Code (Oct 26 2026)', () => {
  const pinRow = { id: 'p1', number: 1, kind: 'bug', priority: 'normal', status: 'open', comment: 'Broken', sessionId: 's1', route: 'tasks', sub: '', createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T16:10:00Z', thread: [] };
  afterEach(async () => { (await import('./store')).store.set({ claude: null }); });

  it('not connected: no Send - Connect Claude Code First, and Connect gives the one line to paste', async () => {
    notes = [pinRow];
    const { store } = await import('./store');
    store.set({ claude: { connected: false, lastSeen: '', apiBase: 'https://api.example' } });
    const { api } = await import('../api');
    api.devNotesTokenCreate = vi.fn(() => Promise.resolve({ id: 't1', token: 'nxbn_abc', label: 'Claude Code', expiresAt: '2026-11-25T00:00:00Z' }));
    render(<Panel {...props} />);
    await screen.findByText('Broken');
    expect(screen.queryByRole('button', { name: /Send To Claude Code/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Connect Claude Code First/ })).toBeTruthy();
    screen.getByRole('button', { name: /Connect My Claude Code/ }).click();
    const line = await screen.findByText(/tools\/build_notes\/connect\.py nxbn_abc --api https:\/\/api\.example/);
    expect(line.textContent).toMatch(/^python3? tools/);
    expect(screen.getByText(/Waiting for your Claude Code/)).toBeTruthy();
  });

  it('connected: Send To Claude Code, and the Queue says your Claude Code is connected', async () => {
    notes = [pinRow];
    const { store } = await import('./store');
    store.set({ claude: { connected: true, lastSeen: '2026-10-26T10:00:00Z', apiBase: '' } });
    render(<Panel {...props} />);
    await screen.findByText('Broken');
    await waitFor(() => expect(screen.getByRole('button', { name: /Send To Claude Code/ })).not.toBeDisabled());
    expect(screen.getByTestId('bm-claude-connected').textContent).toMatch(/Your Claude Code is connected/);
  });
});
