import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, renderHook, waitFor } from '@testing-library/react';

// A ticket reply being written is a kept draft (11/13/2026): one per ticket
// and person, it comes back after a reload, another screen or the drawer
// closing, is cleared when the reply is sent, and is gone after a week. It
// lives in the task module's draft store (tasks/taskDrafts.js).

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
let role = {};
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com', ...role }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
};
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
let me = 'agent@example.com';
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET, { ...TICKET, id: 't2', code: '000002', subject: 'Door badge' }], tasks: [], projects: [],
    myEmail: me, nameOf: (e) => e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');
const { dialog } = await import('../ui/dialog');
const drafts = await import('./ticketDrafts');
const { draftOwner, getReplyDraft, setReplyDraft, clearReplyDraft, replyDraftKey, useTicketReplyDraft, leaveQuestion, noteHeld, clearHeld } = drafts;
const { resetTaskDrafts, TTL_MS } = await import('../tasks/taskDrafts');
const { confirmSwitchTicket } = await import('./drawerGuard');

const AGENT = 'agent@example.com';
const HALF = '<p>Half a reply</p>';
const stored = () => JSON.parse(localStorage.getItem('nexus.taskDrafts') || '{}');

beforeEach(() => { resetTaskDrafts(); me = AGENT; role = {}; updateTicket.mockClear(); updateTicket.mockImplementation(() => Promise.resolve(TICKET)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('whose draft it is', () => {
  it('is the signed-in person, whatever the case', () => {
    expect(draftOwner({ myEmail: 'Pat@Example.com' })).toBe('pat@example.com');
    expect(draftOwner({ myEmail: 'pat@example.com', realEmail: 'pat@example.com' })).toBe('pat@example.com');
  });
  it('under Act As is the administrator acting as that person - never the person', () => {
    const owner = draftOwner({ myEmail: 'pat@example.com', realEmail: 'admin@example.com', actingAs: { targetEmail: 'pat@example.com' } });
    expect(owner).not.toBe('pat@example.com');
    expect(owner).not.toBe('admin@example.com');
    expect(owner).toContain('admin@example.com');
    expect(owner).toContain('pat@example.com');
  });
  it('is nobody when nobody is known, and nothing is kept for nobody', () => {
    expect(draftOwner({})).toBe('');
    setReplyDraft('t1', '', { body: HALF, internal: false });
    expect(getReplyDraft('t1', '')).toEqual({ body: '', internal: false });
    expect(localStorage.getItem('nexus.taskDrafts')).toBeNull();
  });
});

describe('the kept reply', () => {
  it('keeps one draft per ticket, with which box it was', () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    setReplyDraft('t2', AGENT, { body: '<p>For the desk</p>', internal: true });
    expect(getReplyDraft('t1', AGENT)).toEqual({ body: HALF, internal: false });
    expect(getReplyDraft('t2', AGENT)).toEqual({ body: '<p>For the desk</p>', internal: true });
    expect(getReplyDraft('t3', AGENT)).toEqual({ body: '', internal: false });
  });

  it('takes an updater, like the state it replaced', () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    setReplyDraft('t1', AGENT, (r) => ({ ...r, internal: true }));
    setReplyDraft('t1', AGENT, (r) => ({ ...r, body: `${r.body}<p>More</p>` }));
    expect(getReplyDraft('t1', AGENT)).toEqual({ body: `${HALF}<p>More</p>`, internal: true });
  });

  it('is never shown to another person on the same computer', () => {
    setReplyDraft('t1', AGENT, { body: '<p>Internal: do not tell them yet</p>', internal: true });
    expect(getReplyDraft('t1', 'req@example.com')).toEqual({ body: '', internal: false });
    // The next person's own draft sits beside it, and neither replaces the other.
    setReplyDraft('t1', 'req@example.com', { body: '<p>Any news?</p>', internal: false });
    expect(getReplyDraft('t1', AGENT).body).toBe('<p>Internal: do not tell them yet</p>');
    expect(getReplyDraft('t1', 'req@example.com').body).toBe('<p>Any news?</p>');
  });

  it('is cleared when the reply is sent (put back to nothing)', () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: true });
    expect(stored()[replyDraftKey('t1', AGENT)]).toBeTruthy();
    setReplyDraft('t1', AGENT, () => ({ body: '', internal: false }));
    expect(getReplyDraft('t1', AGENT)).toEqual({ body: '', internal: false });
    expect(localStorage.getItem('nexus.taskDrafts')).toBeNull();
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    clearReplyDraft('t1', AGENT);
    expect(getReplyDraft('t1', AGENT).body).toBe('');
  });

  it('survives a reload', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: true });
    vi.resetModules();                                   // a new page: memory is gone, storage is not
    const fresh = await import('./ticketDrafts');
    expect(fresh.getReplyDraft('t1', AGENT)).toEqual({ body: HALF, internal: true });
    expect(fresh.getReplyDraft('t1', 'req@example.com').body).toBe('');
  });

  it('stores the words only - a pasted screenshot stays in memory for this visit', async () => {
    const shot = '<img src="data:image/png;base64,AAAA" alt="">';
    setReplyDraft('t1', AGENT, { body: `<p>See this:</p>${shot}`, internal: false });
    expect(getReplyDraft('t1', AGENT).body).toContain('data:image/png');
    const onDisk = stored()[replyDraftKey('t1', AGENT)];
    expect(onDisk.text).toBe('<p>See this:</p>');
    expect(JSON.stringify(onDisk)).not.toContain('data:image');
    vi.resetModules();
    const fresh = await import('./ticketDrafts');
    expect(fresh.getReplyDraft('t1', AGENT).body).toBe('<p>See this:</p>');
  });

  it('is gone after seven days - from storage and from a tab left open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T09:00:00'));
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    vi.setSystemTime(new Date(Date.now() + TTL_MS - 60000));
    expect(getReplyDraft('t1', AGENT).body).toBe(HALF);
    vi.setSystemTime(new Date(Date.now() + 120000));
    expect(getReplyDraft('t1', AGENT).body).toBe('');     // the tab that stayed open
    vi.resetModules();
    const fresh = await import('./ticketDrafts');
    expect(fresh.getReplyDraft('t1', AGENT).body).toBe(''); // and after a reload
  });
});

describe('useTicketReplyDraft', () => {
  it('comes back with the ticket after the drawer closes', () => {
    const first = renderHook(() => useTicketReplyDraft('t1', AGENT));
    act(() => first.result.current[1]((r) => ({ ...r, body: HALF })));
    expect(first.result.current[0]).toEqual({ body: HALF, internal: false });
    first.unmount();
    const again = renderHook(() => useTicketReplyDraft('t1', AGENT));
    expect(again.result.current[0]).toEqual({ body: HALF, internal: false });
    // Another ticket, and another person on this ticket, start empty.
    expect(renderHook(() => useTicketReplyDraft('t2', AGENT)).result.current[0].body).toBe('');
    expect(renderHook(() => useTicketReplyDraft('t1', 'req@example.com')).result.current[0].body).toBe('');
  });

  it('does not bring back an Internal Note switch flipped over an empty box', () => {
    const first = renderHook(() => useTicketReplyDraft('t1', AGENT));
    act(() => first.result.current[1]((r) => ({ ...r, internal: true })));
    act(() => first.result.current[1]((r) => ({ ...r, body: '<p></p>' })));
    expect(first.result.current[0].internal).toBe(true);
    first.unmount();
    expect(renderHook(() => useTicketReplyDraft('t1', AGENT)).result.current[0]).toEqual({ body: '', internal: false });
  });

  it('with nobody signed in is plain state: it works, and is not kept', () => {
    const first = renderHook(() => useTicketReplyDraft('t1', ''));
    act(() => first.result.current[1]({ body: HALF, internal: false }));
    expect(first.result.current[0].body).toBe(HALF);
    first.unmount();
    expect(renderHook(() => useTicketReplyDraft('t1', '')).result.current[0].body).toBe('');
    expect(localStorage.getItem('nexus.taskDrafts')).toBeNull();
  });
});

describe('leaving a ticket that holds unsaved work', () => {
  it('says what really happens', () => {
    expect(leaveQuestion({ edits: false, reply: false })).toBeNull();
    const both = leaveQuestion({ edits: true, reply: true });
    expect(both.opts.title).toBe('Discard Changes?');
    expect(both.message).toMatch(/Your reply is kept as a draft\./);
    expect(leaveQuestion({ edits: true, reply: false }).message).not.toMatch(/draft/);
    const replyOnly = leaveQuestion({ edits: false, reply: true }, 'Close');
    expect(replyOnly.opts).toMatchObject({ title: 'Reply Not Sent', confirmText: 'Close', cancelText: 'Keep Editing' });
    expect(replyOnly.opts.danger).toBeFalsy();
  });

  it('the screen that swaps tickets asks about a reply without calling it a discard', async () => {
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    noteHeld('t1', false, true);
    await confirmSwitchTicket();
    expect(ask.mock.calls[0][0]).toMatch(/kept as a draft/);
    expect(ask.mock.calls[0][1].title).toBe('Reply Not Sent');
    noteHeld('t1', true, true);
    await confirmSwitchTicket();
    expect(ask.mock.calls[1][1].title).toBe('Discard Changes?');
    expect(ask.mock.calls[1][0]).toMatch(/Your reply is kept as a draft\./);
    clearHeld('t1');
    await confirmSwitchTicket();
    expect(ask.mock.calls[2][0]).not.toMatch(/draft/);
  });
});

describe('the ticket drawer', () => {
  it('opens on the Conversation, holding the reply left unsent last time', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Half a reply')).toBeTruthy();
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
  });

  it('opens on Overview as before when nothing was left unsent', async () => {
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Linked Tickets')).toBeTruthy();
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });

  it('Done sends the kept reply and clears the draft', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: true });
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    await screen.findByText('Half a reply');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTicket).toHaveBeenCalledWith('t1', { comment: HALF, comment_internal: true });
    expect(getReplyDraft('t1', AGENT)).toEqual({ body: '', internal: false });
    expect(localStorage.getItem('nexus.taskDrafts')).toBeNull();
  });

  it('keeps the draft when the save fails', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    updateTicket.mockImplementation(() => Promise.reject(new Error('offline')));
    vi.spyOn(dialog, 'alert').mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    await screen.findByText('Half a reply');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    await waitFor(() => expect(updateTicket).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(getReplyDraft('t1', AGENT).body).toBe(HALF);
  });

  it('closing without Done says the reply is kept - and it is, for the next open', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });
    const ask = vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const onClose = vi.fn();
    const first = render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    await screen.findByText('Half a reply');
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/kept as a draft/);
    expect(ask.mock.calls[0][1]).toMatchObject({ title: 'Reply Not Sent', confirmText: 'Close' });
    expect(onClose).toHaveBeenCalled();
    expect(updateTicket).not.toHaveBeenCalled();
    first.unmount();
    render(<TicketDrawer ticketId="t1" onClose={() => {}} />);
    expect(await screen.findByText('Half a reply')).toBeTruthy();
  });

  it('shows one person nothing of another person\'s draft on the same ticket', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: true });
    me = 'someone.else@example.com';
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    await screen.findByText(/No comments yet\./);
    expect(screen.queryByText('Half a reply')).toBeNull();
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });

  it('under Act As keeps the administrator\'s draft apart from the person\'s own', async () => {
    setReplyDraft('t1', AGENT, { body: HALF, internal: false });           // the person's own draft
    role = { realEmail: 'admin@example.com', actingAs: { targetEmail: AGENT } };
    render(<TicketDrawer ticketId="t1" onClose={() => {}} initialTab="conversation" />);
    await screen.findByText(/No comments yet\./);
    expect(screen.queryByText('Half a reply')).toBeNull();
  });
});
