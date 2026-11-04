import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

// The phone ticket card (Neil, 11/03/2026: "rethink this entire mobile card").
// At phone width the drawer draws TicketPhoneCard: one header with Previous /
// Next and the queue position, one meta line of tappable chips (nothing shown
// twice below), the Conversation first with the reply box pinned in the
// footer, ONE primary action by state and role, the rest in More - Delete a
// hold there. A desktop keeps the drawer exactly as it was.

let ROLE = { myLevel: 3, myEmail: 'agent@example.com' };
let ACCESS = {};
let TICKET;
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: ROLE.myLevel, canAccessModule: () => ROLE.myLevel >= 3,
    myGrantedModules: new Set(), myEmail: ROLE.myEmail }),
}));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => (key === 'getMyTicketAccess' ? () => Promise.resolve(ACCESS)
      : key === 'getTicketComments' ? () => Promise.resolve([
        { id: 'c1', authorId: 'agent@example.com', body: '<p>Looking into it now.</p>', createdAt: '2026-11-03T15:00:00Z' },
      ]) : () => Promise.resolve([])),
  }),
}));
let LIST = null;   // the store's tickets; null = [TICKET]
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...TICKET, ...p }));
// The store drops the row once the delete lands, as TasksContext does.
const deleteTicket = vi.fn(() => { LIST = []; return Promise.resolve(); });
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: LIST || [TICKET], ticketsLoaded: true, tasks: [], projects: [], myEmail: ROLE.myEmail,
    nameOf: (e) => ({ 'agent@example.com': 'Ava Agent', 'req@example.com': 'Rex Requester' })[e] || e,
    updateTicket, deleteTicket, escalateTicket: vi.fn(() => Promise.resolve()), refresh: vi.fn(), reloadTickets: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');
const { phonePrimary } = await import('./TicketPhoneCard');

const IN_PROGRESS = {
  id: 't45', code: '000045', subject: 'GM03 Takes Forever to Sign In', status: 'in_progress', priority: 'medium', type: 'incident',
  description: '<p>Every morning the sign in spins for minutes.</p>', createdAt: '2026-11-03T14:00:00Z',
  requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
  slaDueAt: '2099-01-01T12:00:00Z',
};

let PHONE = true;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  PHONE = true;
  ROLE = { myLevel: 3, myEmail: 'agent@example.com' };
  ACCESS = { role: 'supervisor', privileged: false, canWorkQueue: true, canReadInternal: true, canDelete: true, canManageDesk: true };
  TICKET = { ...IN_PROGRESS };
  LIST = null;
  window.matchMedia = (q) => ({
    matches: PHONE && /max-width:\s*640px/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
});
afterEach(() => {
  cleanup(); updateTicket.mockClear(); deleteTicket.mockClear(); window.matchMedia = realMatchMedia;
  updateTicket.mockImplementation((id, p) => Promise.resolve({ ...TICKET, ...p }));
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const primary = () => within(screen.getByTestId('ticket-phone-actions')).getAllByRole('button').at(-1);

describe('Ticket card on a phone - an agent', () => {
  it('leads with one header: number, position, Previous / Next and Close', async () => {
    const onNext = vi.fn();
    render(<TicketDrawer ticketId="t45" onClose={() => {}} onPrev={null} onNext={onNext} navPosition={{ index: 3, total: 12 }} />);
    await settle();
    expect(screen.getByText('Ticket #45')).toBeTruthy();
    expect(screen.getByTestId('ticket-phone-position').textContent).toBe('3 of 12');
    expect(screen.getByRole('button', { name: 'Previous Ticket' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next Ticket' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    // The old full-width Previous / Next row is gone.
    expect(screen.queryByRole('button', { name: /^Previous$/ })).toBeNull();
  });

  it('shows Status, Priority, Type and the Next Clock once, as chips', async () => {
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    const chips = screen.getByTestId('ticket-phone-chips');
    expect(within(chips).getByText('In Progress')).toBeTruthy();
    expect(within(chips).getByText('Medium')).toBeTruthy();
    expect(within(chips).getByText('Incident')).toBeTruthy();
    expect(within(chips).getByTestId('chip-sla').textContent).toMatch(/Due/);
    // Conversation is the default view, with the description first in the thread.
    expect(screen.getByRole('button', { name: 'Conversation' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('ticket-phone-description').textContent).toMatch(/sign in spins/);
    expect(await screen.findByText('Looking into it now.')).toBeTruthy();
    // Details holds the rest - never the fields the chips and people rows show.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await settle();
    expect(screen.getByText('Company')).toBeTruthy();
    for (const dup of ['Type', 'Status', 'Priority', 'Requester', 'Assign To', 'SLA Due Date']) {
      expect(screen.queryByText(dup, { selector: 'label' })).toBeNull();
    }
  });

  it('a chip opens a bottom-sheet picker; the change is held for Save Changes', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t45" onClose={onClose} />);
    await settle();
    expect(primary().textContent).toMatch('Mark Resolved');
    fireEvent.click(screen.getByTestId('chip-priority'));
    const sheet = screen.getByRole('dialog', { name: 'Priority' });
    fireEvent.click(within(sheet).getByRole('button', { name: /High/ }));
    expect(updateTicket).not.toHaveBeenCalled();
    expect(primary().textContent).toMatch('Save Changes');
    await act(async () => { fireEvent.click(primary()); });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    expect(updateTicket).toHaveBeenCalledWith('t45', { priority: 'high' });
    // Saved in place - the card stays open on a phone.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pins the reply box in the footer, outside the scrolling body', async () => {
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    const composer = screen.getByTestId('ticket-phone-composer');
    expect(composer.closest('.nx-scroll')).toBeNull();
    expect(within(composer).getByRole('button', { name: 'Internal Note' })).toBeTruthy();
    expect(within(composer).getByRole('button', { name: 'Send Reply' }).disabled).toBe(true);
    // Files and Activity carry no reply box.
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.queryByTestId('ticket-phone-composer')).toBeNull();
  });

  it('keeps one primary; Escalate and Delete live in More, Delete as a hold', async () => {
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    const bar = screen.getByTestId('ticket-phone-actions');
    expect(within(bar).getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['More', 'Mark Resolved']);
    expect(within(bar).queryByText(/Delete|Escalate|Done/)).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: /More/ }));
    const more = screen.getByTestId('ticket-phone-more');
    expect(within(more).getByText('Escalate')).toBeTruthy();
    const del = within(more).getByRole('button', { name: 'Delete Ticket, press and hold' });
    expect(del).toBeTruthy();
    // A tap is not a delete.
    fireEvent.pointerDown(del); fireEvent.pointerUp(del);
    expect(deleteTicket).not.toHaveBeenCalled();
  });

  it('a resolved ticket leads with Reopen for the desk', async () => {
    TICKET = { ...IN_PROGRESS, status: 'resolved', resolvedAt: '2026-11-03T16:00:00Z', resolution: 'fixed', resolutionNote: 'Cleared the cache.' };
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    expect(primary().textContent).toMatch('Reopen');
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(within(screen.getByTestId('ticket-phone-more')).getByText('Confirm Resolution')).toBeTruthy();
  });
});

describe('Ticket card on a phone - review fixes', () => {
  it('Delete closes the card once the store drops the ticket', async () => {
    const { dialog } = await import('../ui/dialog');
    // A click with no press behind it is the hold's accessible path: the
    // ordinary confirm, then the same delete.
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    const onClose = vi.fn();
    const { rerender } = render(<TicketDrawer ticketId="t45" onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Ticket, press and hold' })); });
    await settle();
    expect(deleteTicket).toHaveBeenCalledWith('t45');
    // The row is gone from the store and the card with it - yet it closed.
    rerender(<TicketDrawer ticketId="t45" onClose={onClose} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an edit made while a save is on its way is still held after it lands', async () => {
    let land;
    updateTicket.mockImplementationOnce((id, p) => new Promise((res) => { land = () => res({ ...TICKET, ...p }); }));
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByTestId('chip-priority'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Priority' })).getByRole('button', { name: /High/ }));
    await act(async () => { fireEvent.click(primary()); });
    expect(updateTicket).toHaveBeenCalledWith('t45', { priority: 'high' });
    // Still saving: change the type.
    fireEvent.click(screen.getByTestId('chip-type'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Type' })).getByRole('button', { name: /^Bug Report/ }));
    await act(async () => { land(); });
    await settle();
    // The priority went out and is cleared; the type is still held.
    expect(primary().textContent).toMatch('Save Changes');
    await act(async () => { fireEvent.click(primary()); });
    expect(updateTicket).toHaveBeenLastCalledWith('t45', { type: 'bug' });
  });

  it('a swipe steps tickets, but never from the viewer, a section switch or selected text', async () => {
    const onNext = vi.fn();
    render(<TicketDrawer ticketId="t45" onClose={() => {}} onPrev={null} onNext={onNext} />);
    await settle();
    const swipeOn = (el) => {
      fireEvent.touchStart(el, { touches: [{ clientX: 320, clientY: 200 }] });
      for (let x = 300; x >= 120; x -= 30) fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: 202 }] });
      fireEvent.touchEnd(el, { touches: [] });
    };
    swipeOn(screen.getByTestId('ticket-phone-people'));
    expect(onNext).toHaveBeenCalledTimes(1);
    swipeOn(screen.getByRole('button', { name: 'Details' }));         // the sticky switch is data-no-swipe
    swipeOn(screen.getByTestId('ticket-phone-description').querySelector('.nx-rich-body'));
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false });
    swipeOn(screen.getByTestId('ticket-phone-people'));
    sel.mockRestore();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('the shared attachment viewer opts out of the card swipe', async () => {
    const { AttachmentViewer } = await import('../tasks/components');
    render(<AttachmentViewer att={{ url: '', name: 'photo.png', kind: 'image' }} onClose={() => {}} />);
    expect(document.querySelector('[data-no-swipe]')).toBeTruthy();
  });
});

describe('Ticket card on a phone - the requester', () => {
  beforeEach(() => {
    ROLE = { myLevel: 1, myEmail: 'req@example.com' };
    ACCESS = { role: 'requester', canWorkQueue: false, canReadInternal: false, canDelete: false, canManageDesk: false };
  });

  it('reads the chips without changing them, replies without the note switch, and can mark it resolved', async () => {
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    const chips = screen.getByTestId('ticket-phone-chips');
    expect(within(chips).queryByRole('button', { name: /Status/ })).toBeNull();
    expect(within(chips).queryByRole('button', { name: /Priority/ })).toBeNull();
    const composer = screen.getByTestId('ticket-phone-composer');
    expect(within(composer).queryByRole('button', { name: 'Internal Note' })).toBeNull();
    expect(primary().textContent).toMatch('Mark Resolved');
    // Nothing else is theirs here, so no More at all.
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull();
    // The assignee row is read-only for them.
    expect(screen.queryByRole('button', { name: /Assignee/ })).toBeNull();
  });

  it('confirms a resolution as the primary, with Reopen in More', async () => {
    TICKET = { ...IN_PROGRESS, status: 'resolved', resolvedAt: '2026-11-03T16:00:00Z', resolution: 'fixed' };
    render(<TicketDrawer ticketId="t45" onClose={() => {}} />);
    await settle();
    expect(primary().textContent).toMatch('Confirm Resolution');
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(within(screen.getByTestId('ticket-phone-more')).getByText('Reopen')).toBeTruthy();
    expect(within(screen.getByTestId('ticket-phone-more')).queryByText(/Delete/)).toBeNull();
  });
});

describe('phonePrimary', () => {
  const base = { t: { status: 'in_progress' }, v: { status: 'in_progress' }, pendingCount: 0, hasReply: false, onConversation: true, canEditStatus: true, ownRequester: false };
  it('picks by state and role', () => {
    expect(phonePrimary(base)).toBe('resolve');
    expect(phonePrimary({ ...base, pendingCount: 1 })).toBe('save');
    expect(phonePrimary({ ...base, hasReply: true })).toBe('resolve');            // the reply box has its own Send
    expect(phonePrimary({ ...base, hasReply: true, onConversation: false })).toBe('send');
    expect(phonePrimary({ ...base, t: { status: 'resolved' }, v: { status: 'resolved' } })).toBe('reopen');
    expect(phonePrimary({ ...base, t: { status: 'resolved' }, v: { status: 'resolved' }, canEditStatus: false, ownRequester: true })).toBe('confirm');
    expect(phonePrimary({ ...base, t: { status: 'closed' }, v: { status: 'closed' }, canEditStatus: false, ownRequester: true })).toBe('done');
    expect(phonePrimary({ ...base, canEditStatus: false })).toBe('done');
  });
});

describe('Ticket drawer on a desktop', () => {
  it('is the drawer it always was', async () => {
    PHONE = false;
    render(<TicketDrawer ticketId="t45" onClose={() => {}} onPrev={null} onNext={() => {}} navPosition={{ index: 3, total: 12 }} />);
    await settle();
    expect(document.querySelector('[data-layout="phone"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeTruthy();
    expect(screen.queryByText('3 of 12')).toBeNull();
    expect(screen.getByText('Requester', { selector: 'label' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy();
  });
});
