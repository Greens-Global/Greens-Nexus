import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// The panel while Send to Claude Code is on hold (meta.CLAUDE_SEND_ON off,
// Pranshu Oct 27): no Send To Claude Code, no Settings tab, and Post To Teams
// is the main button - opened from Done, it goes straight to the chat list.

let notes = [];
vi.mock('../api', () => ({
  api: {
    devNotesList: vi.fn((p) => Promise.resolve(p?.status === 'dismissed' ? [] : notes)),
    devNotesSessions: vi.fn(() => Promise.resolve([])),
    devNotesStats: vi.fn(() => Promise.resolve(null)),
    timeMyChats: vi.fn(() => Promise.resolve({ chats: [{ id: 'c1', name: 'Nexus - Feedback and Bugs', chatType: 'group' }] })),
  },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));

// The switch is on in the app (Oct 27); this file covers it turned off.
vi.mock('./meta', async (importOriginal) => ({ ...(await importOriginal()), CLAUDE_SEND_ON: false }));

const Panel = (await import('./Panel')).default;
afterEach(() => { cleanup(); notes = []; });

const mine = { id: 'p1', number: 1, kind: 'change', priority: 'normal', status: 'open', comment: 'Make this bigger', sessionId: 's1', route: 'tasks', createdBy: 'me@x.com', createdAt: '2026-10-27T16:10:00Z', thread: [] };
const props = { open: true, tab: 'queue', onTab: vi.fn(), onClose: vi.fn(), settings: {}, onSettings: vi.fn(() => Promise.resolve()), onOpenPin: vi.fn(), myEmail: 'me@x.com' };

describe('Panel while Send to Claude Code is on hold', () => {
  it('has no Send To Claude Code and no Settings tab, even when asked for Settings', async () => {
    notes = [mine];
    render(<Panel {...props} tab="settings" />);
    await screen.findByText('Make this bigger');
    expect(screen.queryByRole('button', { name: /Send To Claude Code/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.getByText(/1 of yours ready to post/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Post To Teams/ }).className).toMatch(/bm-btn-primary/);
  });

  it('opened from Done with no chat picked, the chat list opens straight away', async () => {
    notes = [mine];
    render(<Panel {...props} postFromDone />);
    expect(await screen.findByRole('option', { name: /Nexus - Feedback and Bugs/ })).toBeTruthy();
  });

  it('opened from Done with a chat picked, Post is the button in focus', async () => {
    notes = [mine];
    render(<Panel {...props} settings={{ teamsChatId: 'c1', teamsChatName: 'Ankush' }} postFromDone />);
    const post = await screen.findByRole('button', { name: 'Post To Teams - Ankush' });
    await waitFor(() => expect(document.activeElement).toBe(post));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
