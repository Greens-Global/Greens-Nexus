import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';

// Help Center on a phone (Neil, 10/28/2026: "this ticket section sucks on
// mobile"): tickets are cards, not a squeezed table; the tabs fit the width
// with short labels; the header sort becomes one Sort box; a card opens the
// ticket and its buttons do only their own thing.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myLevel: 1, canAccessModule: () => false,
    myGrantedModules: new Set(), myEmail: 'req@example.com' }),
}));
const MINE = [
  { id: 't1', code: '000052', subject: 'Zulu printer jam', status: 'in_progress', requesterId: 'req@example.com',
    createdAt: '2026-10-01T10:00:00', modifiedAt: '2026-10-28T22:06:00',
    latestComment: { authorId: 'agent@example.com', preview: 'On my way', createdAt: '2026-10-28T22:06:00', internal: false } },
  { id: 't2', code: '000053', subject: 'Alpha badge reader', status: 'new', requesterId: 'req@example.com',
    createdAt: '2026-10-20T10:00:00', modifiedAt: '2026-10-20T10:00:00', latestComment: null },
  { id: 't3', code: '000054', subject: 'Lobby door', status: 'in_progress', requesterId: 'kim@example.com',
    watcherIds: ['req@example.com'], createdAt: '2026-10-02T10:00:00', latestComment: null },
];
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => () => Promise.resolve(
    k === 'getToursSeen' ? { seen: { support: true } } : k === 'getMyTickets' ? MINE : []) }),
}));
// The Ticket module's drawer and dialog, as markers.
vi.mock('../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => children }));
vi.mock('../tickets/TicketsView', () => ({
  TicketDrawer: ({ ticketId }) => <div data-testid="drawer">{ticketId}</div>,
  TicketActionDialog: ({ mode }) => <div data-testid="action-dialog">{mode}</div>,
  CreateTicketModal: () => null,
}));

// A phone: every phone media query matches.
const realMatchMedia = globalThis.matchMedia;
beforeAll(() => {
  globalThis.matchMedia = (q) => ({
    matches: /max-width/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
});
afterAll(() => { globalThis.matchMedia = realMatchMedia; });
afterEach(cleanup);

const { default: Support } = await import('./Support');
const cardTitles = () => screen.getAllByTestId('ticket-card').map((c) => c.textContent);

describe('Help Center on a phone', () => {
  it('lists tickets as cards with no table header, and the full status', async () => {
    const { container } = render(<Support activeSub={null} onSubChange={() => {}} />);
    await screen.findByText('Zulu printer jam');
    expect(container.querySelector('[data-layout]').dataset.layout).toBe('cards');
    expect(screen.queryByTitle('Sort by Title')).toBeNull();
    expect(screen.queryByText('Latest Comment')).toBeNull();
    const card = screen.getAllByTestId('ticket-card').find((c) => c.textContent.includes('Zulu'));
    expect(within(card).getByText('In Progress')).toBeTruthy();
    expect(card.textContent).toMatch(/Updated 10\/28\/2026 10:06 PM/);
    expect(within(card).getByText(/On my way/)).toBeTruthy();
  });

  it('labels the tabs Open, Following and Closed', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    await screen.findByText('Zulu printer jam');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent.replace(/\d+$/, ''));
    expect(tabs).toEqual(['Open', 'Following', 'Closed']);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Following/ })); });
    expect(await screen.findByText('Lobby door')).toBeTruthy();
  });

  it('sorts from the Sort box', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    await screen.findByText('Zulu printer jam');
    const sort = screen.getByRole('combobox', { name: 'Sort tickets' });
    await act(async () => { fireEvent.change(sort, { target: { value: 'title:asc' } }); });
    expect(cardTitles()[0]).toMatch(/Alpha/);
    await act(async () => { fireEvent.change(sort, { target: { value: 'title:desc' } }); });
    expect(cardTitles()[0]).toMatch(/Zulu/);
  });

  it('opens the ticket from the card, but Mark Resolved only opens its dialog', async () => {
    render(<Support activeSub={null} onSubChange={() => {}} />);
    await screen.findByText('Zulu printer jam');
    const card = screen.getAllByTestId('ticket-card').find((c) => c.textContent.includes('Zulu'));
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: /Mark Resolved/ })); });
    expect(await screen.findByTestId('action-dialog')).toBeTruthy();
    expect(screen.queryByTestId('drawer')).toBeNull();
    await act(async () => { fireEvent.click(card); });
    expect((await screen.findByTestId('drawer')).textContent).toBe('t1');
  });
});
