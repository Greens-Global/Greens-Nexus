import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

// The Tickets list on a phone (Oct 2026 mobile pass): a rotate across 640px
// must never crash the view, and the phone layout gets its own search, sort,
// filter sheet footer, readable due dates, a touch-friendly board and a tour
// that names the tabs it is pointing at.
//
// vitest.setup.js stubs matchMedia to "never matches", so every test here
// installs its own: PHONE decides whether '(max-width: 640px)' matches, and
// flip() fires the change listeners the way a real rotate does.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
let TOURS_SEEN = true;
vi.mock('../api', () => {
  const answer = (k) => (k === 'getToursSeen' ? { seen: { ticket: TOURS_SEEN, support: true } } : []);
  return { api: new Proxy({}, { get: (_, k) => () => Promise.resolve(answer(k)) }) };
});

const BASE_TICKETS = [
  { id: 't1', code: '000001', subject: 'Printer jam', status: 'in_progress', priority: 'medium', type: 'incident',
    requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
    createdAt: '2026-09-30T10:00:00', slaDueOn: '2026-01-05', latestComment: null },
  { id: 't2', code: '000002', subject: 'VPN down', status: 'open', priority: 'high', type: 'incident',
    requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
    createdAt: '2026-09-30T11:00:00', latestComment: null },
];
let TICKETS = BASE_TICKETS;
const updateTicket = vi.fn((id, p) => Promise.resolve({ ...TICKETS.find((t) => t.id === id), ...p }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: TICKETS, ticketsLoaded: true, ticketViews: [], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => ({ 'agent@example.com': 'Ava Agent', 'req@example.com': 'Rex Requester' })[e] || e,
    updateTicket, deleteTicket: vi.fn(), refresh: vi.fn(), createTicketView: vi.fn(), deleteTicketView: vi.fn() }),
}));

const { default: TicketsView } = await import('./TicketsView');

// ── controllable matchMedia ────────────────────────────────────────────────
let PHONE = true;
let listeners = [];
const evalQuery = (q) => PHONE && /max-width:\s*640px/.test(q);
const realMatchMedia = window.matchMedia;
function installMatchMedia() {
  listeners = [];
  window.matchMedia = (q) => ({
    get matches() { return evalQuery(q); },
    media: q, onchange: null,
    addEventListener: (_t, fn) => { listeners.push({ q, fn }); },
    removeEventListener: (_t, fn) => { listeners = listeners.filter((l) => l.fn !== fn); },
    addListener: (fn) => { listeners.push({ q, fn }); },
    removeListener: (fn) => { listeners = listeners.filter((l) => l.fn !== fn); },
    dispatchEvent: () => false,
  });
}
// One act() per listener: the browser does not promise that every hook
// listening to the same query re-renders in the same pass, and the original
// crash lived in exactly that gap.
async function flip(phone) {
  PHONE = phone;
  for (const { q, fn } of [...listeners]) {
    await act(async () => { fn({ matches: evalQuery(q), media: q }); });
  }
}

// jsdom has no scrollIntoView; GuidedTour calls it on every step it finds.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
beforeEach(() => { PHONE = true; TICKETS = BASE_TICKETS; TOURS_SEEN = true; installMatchMedia(); });
afterEach(() => { cleanup(); updateTicket.mockClear(); window.matchMedia = realMatchMedia; });

const rowOrder = () => screen.getAllByText(/^(Printer jam|VPN down)$/).map((n) => n.textContent);

describe('Tickets - rotating across the phone breakpoint', () => {
  it('flips phone -> desktop -> phone without throwing', async () => {
    render(<TicketsView />);
    expect(await screen.findByText('Printer jam')).toBeTruthy();
    expect(screen.getByLabelText('Search tickets')).toBeTruthy();   // phone chrome

    await flip(false);
    expect(screen.getByText('Latest Comment')).toBeTruthy();   // desktop column header
    expect(screen.getByText('Printer jam')).toBeTruthy();

    await flip(true);
    expect(screen.getByLabelText('Search tickets')).toBeTruthy();
    expect(screen.getByText('VPN down')).toBeTruthy();
  });

  it('flips desktop -> phone -> desktop without throwing', async () => {
    PHONE = false;
    render(<TicketsView />);
    expect(await screen.findByText('Latest Comment')).toBeTruthy();
    await flip(true);
    expect(screen.getByText('Printer jam')).toBeTruthy();
    await flip(false);
    expect(screen.getByText('Latest Comment')).toBeTruthy();
  });

  it('clears a desktop bulk selection on the way into the phone layout', async () => {
    PHONE = false;
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    const box = container.querySelector('.nx-row-hover input[type="checkbox"]');
    await act(async () => { fireEvent.click(box); });
    expect(screen.getByText('1 selected')).toBeTruthy();

    await flip(true);
    expect(screen.queryByText('1 selected')).toBeNull();
    // ...and it is gone, not just hidden: back on desktop nothing is ticked.
    await flip(false);
    expect(screen.queryByText('1 selected')).toBeNull();
  });
  it('rotates mid-tour (7 desktop steps -> 3 phone steps) without throwing', async () => {
    PHONE = false;
    TOURS_SEEN = false;
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const tour = await screen.findByRole('dialog', { name: 'Guided walkthrough' });
    for (let n = 0; n < 5; n += 1) {
      await act(async () => { fireEvent.click(within(tour).getByRole('button', { name: /Next/ })); });
    }
    expect(within(tour).getByText(/step 6 of 7/)).toBeTruthy();
    await flip(true);
    const after = screen.getByRole('dialog', { name: 'Guided walkthrough' });
    expect(within(after).getByText(/step 3 of 3/)).toBeTruthy();
    expect(within(after).getByRole('button', { name: /Done/ })).toBeTruthy();
  });
});

describe('Tickets on a phone', () => {
  it('searches from the row under the scope tabs, and clears it', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const box = screen.getByLabelText('Search tickets');
    expect(box.style.fontSize).toBe('16px');   // no iOS focus zoom
    // Not type=search: its native cancel X would double up with ours.
    expect(box.getAttribute('type')).toBe('text');
    expect(box.getAttribute('inputmode')).toBe('search');
    fireEvent.change(box, { target: { value: 'vpn' } });
    expect(screen.queryByText('Printer jam')).toBeNull();
    expect(screen.getByText('VPN down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Printer jam')).toBeTruthy();
    expect(box.value).toBe('');
  });

  it('sorts from the filter sheet - Newest First by default', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(rowOrder()).toEqual(['VPN down', 'Printer jam']);
    fireEvent.click(screen.getByRole('button', { name: 'Filters & sort' }));
    expect(screen.getByText('Filter, Sort & Group')).toBeTruthy();
    expect(screen.getByText('Sort By')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Newest First/ }));
    fireEvent.click(screen.getByText('Oldest First'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(rowOrder()).toEqual(['Printer jam', 'VPN down']);
  });

  it('sorting by Due Date puts tickets with no SLA date last', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(rowOrder()).toEqual(['VPN down', 'Printer jam']);   // newest first
    fireEvent.click(screen.getByRole('button', { name: 'Filters & sort' }));
    fireEvent.click(screen.getByRole('button', { name: /Newest First/ }));
    fireEvent.click(screen.getByText('Due Date'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // VPN down has no slaDueOn - it no longer leads the list.
    expect(rowOrder()).toEqual(['Printer jam', 'VPN down']);
  });

  it('hides Sort By outside the list, where nothing is sorted', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: /^List/ }));
    fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    await screen.findByTestId('ticket-board');
    fireEvent.click(screen.getByRole('button', { name: 'Filters & sort' }));
    expect(screen.queryByText('Sort By')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('pins Done in a sticky footer and offers Clear All once a filter is on', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: 'Filters & sort' }));
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.parentElement.style.position).toBe('sticky');
    expect(screen.queryByRole('button', { name: 'Clear All' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /All priorities/ }));
    fireEvent.click(within(screen.getByPlaceholderText('Search…').parentElement).getByText('High'));
    expect(screen.queryByText('Printer jam')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }));
    expect(screen.queryByRole('button', { name: 'Clear All' })).toBeNull();
    expect(screen.getByText('Printer jam')).toBeTruthy();
  });

  it('spells out the SLA due date and the needs-a-comment state on the card', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    const due = screen.getByTestId('ticket-row-due');
    expect(due.textContent).toMatch(/Due 01\/05\/2026/);
    expect(due.style.color).toBe('rgb(220, 38, 38)');   // breached = red
    expect(screen.getAllByText(/Needs a Comment/).length).toBeGreaterThan(0);
  });

  it('leaves room under the list for the floating bar', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(screen.getByTestId('ticket-bar-spacer')).toBeTruthy();
    // The spacer does the clearing; the body's own phone padding stays small
    // so the two never stack once .nx-gutter stops overriding it.
    expect(document.querySelector('[data-tour="ticket-body"]').style.paddingBottom).toBe('8px');
  });

  it('empty state points at the + button the phone actually shows', async () => {
    TICKETS = [];
    render(<TicketsView />);
    expect(await screen.findByText(/Tap \+ below to report a problem/)).toBeTruthy();
    expect(screen.queryByText(/New Ticket/)).toBeNull();
  });

  it('the board has no dragging and moves cards through the guarded update', async () => {
    render(<TicketsView />);
    await screen.findByText('Printer jam');
    fireEvent.click(screen.getByRole('button', { name: /^List/ }));
    fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    const board = await screen.findByTestId('ticket-board');
    expect(board.style.scrollSnapType).toBe('x mandatory');
    const card = within(board).getByText('VPN down').closest('[draggable]');
    expect(card.getAttribute('draggable')).toBe('false');

    // An ordinary move saves straight away...
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: /Move #?0*2 To/ }), { target: { value: 'in_progress' } });
    });
    expect(updateTicket).toHaveBeenCalledWith('t2', { status: 'in_progress' });

    // ...but Resolved still asks for the resolution first.
    updateTicket.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: /Move #?0*1 To/ }), { target: { value: 'resolved' } });
    });
    expect(updateTicket).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /Resolve/ }).length).toBeGreaterThan(0);
  });

  it('the tour spotlights the phone scope tabs and names them as the phone does', async () => {
    TOURS_SEEN = false;
    const { container } = render(<TicketsView />);
    await screen.findByText('Printer jam');
    expect(container.querySelector('[data-tour="ticket-scope"]')).toBeTruthy();
    const tour = await screen.findByRole('dialog', { name: 'Guided walkthrough' });
    expect(tour.classList.contains('guided-tour')).toBe(true);
    expect(within(tour).getByText(/Mine is what you raised; Assigned is what you are working/)).toBeTruthy();
    expect(within(tour).queryByText(/My Requests/)).toBeNull();
  });
});
