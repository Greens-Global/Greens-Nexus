// The header search finds everything you can open (11/13/2026): tickets by
// subject or number, notes and boards, documents, people for someone with no
// Tasks grant, and the bolt's Quick Actions by name. Each source answers on
// its own - one failing never blanks the others - a module the person cannot
// open is never asked, and the arrow keys travel across the new groups.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ role: {}, nav: new Set(), api: {} }));
vi.mock('../../api', () => ({
  api: new Proxy({}, { get: (_, k) => state.api[k] || (() => Promise.resolve({ enabled: false })) }),
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => state.role }));
vi.mock('../../contexts/InventoryContext', () => ({ useInventory: () => ({ items: [], checkouts: [] }) }));
vi.mock('../../contexts/RequisitionContext', () => ({ useRequisitions: () => ({ requisitions: [] }) }));
vi.mock('../Sidebar', () => ({
  NAV: ['dashboard', 'myhr', 'tasks', 'tickets', 'support', 'documents', 'shifts', 'inventory'].map((view) => ({ view, label: `Screen ${view}` })),
  isNavItemVisible: (item) => state.nav.has(item.view),
}));
vi.mock('../MobileMenu', () => ({ SUBMENUS: {}, visibleSubs: () => null }));

const { default: GlobalSearch } = await import('../GlobalSearch');
const { resetLinksSearchCache } = await import('./useNexusSearch');
const { __setTablePrefsCache } = await import('../../tasks/tableCols');
const { takeQuickAction } = await import('../../lib/quickCreate');
const { takePendingOpen, __clearPendingOpen } = await import('../../lib/pendingOpen');

const EVERYONE = ['dashboard', 'myhr', 'support', 'shifts', 'inventory'];
const person = (over = {}, nav = EVERYONE) => {
  state.role = { myRole: 'employee', isExternal: false, can: () => false, canAccessModule: () => false, myGrantedModules: new Map(), myEmail: 'pat@x.com', ...over };
  state.nav = new Set(nav);
};
const refused = () => Promise.reject(new Error('403'));
const sections = () => [...document.querySelectorAll('.gs-section')].map((n) => n.textContent);
const open = (q) => {
  render(<GlobalSearch />);
  fireEvent(window, new CustomEvent('nexus:search-open'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: q } });
};
const heard = (name) => {
  const seen = [];
  const on = (e) => seen.push(e.detail);
  window.addEventListener(name, on);
  return { seen, stop: () => window.removeEventListener(name, on) };
};

beforeEach(() => {
  resetLinksSearchCache();
  __setTablePrefsCache({ search: { data: { favorites: [], recents: [] } } });
  __clearPendingOpen();
  takeQuickAction();
  state.api = {
    searchTaskModule: vi.fn(refused),          // no Tasks grant: the Task module's search refuses
    searchJobs: vi.fn(refused),
    kbSearch: vi.fn(() => Promise.resolve({ results: [] })),
    getExternalLinks: () => Promise.resolve([]),
    getPersonalLinks: () => Promise.resolve([]),
    saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
    searchTicketsEverywhere: vi.fn(() => Promise.resolve({ tickets: [] })),
    searchNotes: vi.fn(() => Promise.resolve({ notes: [] })),
    searchDocumentLibrary: vi.fn(() => Promise.resolve([])),
    getPeopleDirectory: vi.fn(() => Promise.resolve([])),
  };
  person();
});
afterEach(() => { cleanup(); __setTablePrefsCache(null); });

describe('Tickets in search', () => {
  it('finds a ticket by its subject and opens it on Support for someone off the desk', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Printer is on fire', status: 'in_progress', view: 'support' },
    ] }));
    const nav = heard('nexus:navigate');
    const opened = heard('nexus:open-ticket');
    open('printer');
    const row = await screen.findByText('Printer is on fire');
    expect(state.api.searchTicketsEverywhere).toHaveBeenCalledWith('printer', 5);
    expect(sections()).toEqual(['Tickets']);
    fireEvent.click(row);
    expect(nav.seen).toEqual([{ view: 'support', sub: undefined }]);
    expect(takePendingOpen('ticket')).toBe('k1');
    await waitFor(() => expect(opened.seen).toEqual([{ ticketId: 'k1' }]));
    nav.stop(); opened.stop();
  });

  it('shows the number and the status in Title Case', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Printer is on fire', status: 'waiting_user', view: 'support' },
    ] }));
    open('printer');
    expect(await screen.findByText('#41 · Waiting for User')).toBeTruthy();
  });

  it('opens on the desk for an agent, and never for someone the left menu does not give the desk', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Printer is on fire', status: 'open', view: 'tickets' },
    ] }));
    person({}, [...EVERYONE, 'tickets']);
    let nav = heard('nexus:navigate');
    open('printer');
    fireEvent.click(await screen.findByText('Printer is on fire'));
    expect(nav.seen[0].view).toBe('tickets');
    nav.stop(); cleanup();
    person();
    nav = heard('nexus:navigate');
    open('printer');
    fireEvent.click(await screen.findByText('Printer is on fire'));
    expect(nav.seen[0].view).toBe('support');
    nav.stop();
  });

  it('a typed number that is a ticket leads the results', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Printer is on fire', status: 'open', view: 'support', exact: true },
    ] }));
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve([{ email: 'room41@x.com', name: 'Room 41' }]));
    open('41');
    await screen.findByText('Printer is on fire');
    await screen.findByText('Room 41');
    expect(sections().slice(0, 2)).toEqual(['Tickets', 'People']);
  });

  it('an Ask HR ticket is found and opened but never kept in Favorites or Recent', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k9', code: '000050', subject: 'Payroll question', status: 'open', view: 'support', confidential: true },
      { id: 'k1', code: '000041', subject: 'Payroll printer', status: 'open', view: 'support' },
    ] }));
    open('payroll');
    await screen.findByText('Payroll question');
    expect(screen.queryByRole('button', { name: 'Add Payroll question to Favorites' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Payroll printer to Favorites' })).toBeTruthy();
    fireEvent.click(screen.getByText('Payroll question'));
    expect(takePendingOpen('ticket')).toBe('k9');
    expect(state.api.saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('a saved ticket reopens the same way', async () => {
    __setTablePrefsCache({ search: { data: { favorites: [], recents: [
      { key: 'ticket:k1', kind: 'ticket', title: 'Printer is on fire', detail: '#41 · Open', to: { ticket: 'k1', view: 'tickets' } },
    ] } } });
    const nav = heard('nexus:navigate');
    render(<GlobalSearch />);
    fireEvent(window, new CustomEvent('nexus:search-open'));
    fireEvent.click(screen.getByText('Printer is on fire'));
    expect(nav.seen[0].view).toBe('support');          // saved on the desk, opened without it: Support
    expect(takePendingOpen('ticket')).toBe('k1');
    nav.stop();
  });
});

describe('Notes and documents in search', () => {
  it('finds notes and boards and opens one on Dashboard > Notes', async () => {
    state.api.searchNotes = vi.fn(() => Promise.resolve({ notes: [
      { id: 'note_a1', kind: 'note', title: 'Gate repair plan', mine: true },
      { id: 'note_b2', kind: 'board', title: '', mine: false },
      { id: 'note_c3', kind: 'daily', title: '', day: '2026-11-06', mine: true },
    ] }));
    const nav = heard('nexus:navigate');
    open('gate');
    expect(await screen.findByText('Gate repair plan')).toBeTruthy();
    expect(screen.getByText('Untitled Board')).toBeTruthy();
    expect(screen.getByText('Board · Shared With You')).toBeTruthy();
    expect(screen.getByText('Daily Scratchpad')).toBeTruthy();
    expect(screen.getByText('Note · 11/06/2026')).toBeTruthy();
    fireEvent.click(screen.getByText('Gate repair plan'));
    expect(nav.seen).toEqual([{ view: 'dashboard', sub: 'notes:note_a1' }]);
    nav.stop();
  });

  it('finds a document only for someone who can open Documents, and opens it beside the library list', async () => {
    state.api.searchDocumentLibrary = vi.fn(() => Promise.resolve([
      { id: 'd1', kind: 'document', title: 'Lease Agreement', status: 'draft', forName: 'Jordan Lee', company: 'Greens Global' },
      { id: 'sign:r1', kind: 'envelope', title: 'Lease Renewal', status: 'archived' },
    ]));
    open('lease');
    await waitFor(() => expect(state.api.searchNotes).toHaveBeenCalled());
    expect(state.api.searchDocumentLibrary).not.toHaveBeenCalled();
    cleanup();

    person({ canAccessModule: (m) => m === 'documents' }, [...EVERYONE, 'documents']);
    const nav = heard('nexus:navigate');
    const opened = heard('nexus:open-document');
    open('lease');
    expect(await screen.findByText('Lease Agreement')).toBeTruthy();
    expect(screen.getByText('Document · Jordan Lee · Greens Global')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    fireEvent.click(screen.getByText('Lease Agreement'));
    expect(nav.seen).toEqual([{ view: 'documents', sub: 'documents-browse' }]);
    expect(takePendingOpen('document')).toBe('d1');
    await waitFor(() => expect(opened.seen).toEqual([{ id: 'd1' }]));
    expect(state.api.saveTaskTablePrefs.mock.calls.at(-1)[1].data.recents[0])
      .toMatchObject({ key: 'doc:d1', kind: 'document', to: { doc: 'd1' } });
    nav.stop(); opened.stop();
  });
});

describe('People for everyone', () => {
  const DIRECTORY = [
    { email: 'zed@x.com', name: 'Zed Charm' },
    { email: 'charmi@x.com', name: 'Charmi Patel' },
    { email: 'charles@x.com', name: 'Charles Wu' },
    { email: 'other@x.com', name: 'Someone Else' },
  ];

  it('someone with no Tasks grant finds people from the Nexus People directory and opens their contact card', async () => {
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve(DIRECTORY));
    const nav = heard('nexus:navigate');
    open('char');
    await screen.findByText('Charmi Patel');
    // A name that starts with the words first, then alphabetical.
    expect([...document.querySelectorAll('.gs-row-title')].map((n) => n.textContent)).toEqual(['Charles Wu', 'Charmi Patel', 'Zed Charm']);
    expect(screen.queryByText('Someone Else')).toBeNull();
    fireEvent.click(screen.getByText('Charmi Patel'));
    expect(nav.seen).toEqual([{ view: 'shifts', sub: 'contact' }]);
    expect(takePendingOpen('directory')).toBe('charmi@x.com');
    nav.stop();
  });

  it('a person the Task search also returns is listed once, and opens their Tasks page for someone with Tasks', async () => {
    person({ myGrantedModules: new Map([['tasks', 'editor']]) }, [...EVERYONE, 'tasks']);
    state.api.searchTaskModule = vi.fn(() => Promise.resolve({
      tasks: [], projects: [], portfolios: [], teams: [], people: [{ email: 'Charmi@x.com', name: 'Charmi Patel' }], totals: {},
    }));
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve(DIRECTORY));
    const nav = heard('nexus:navigate');
    open('char');
    await screen.findByText('Charles Wu');
    expect(screen.getAllByText('Charmi Patel')).toHaveLength(1);
    fireEvent.click(screen.getByText('Charles Wu'));
    expect(nav.seen).toEqual([{ view: 'tasks', sub: 'home' }]);
    nav.stop();
  });

  it('an external guest is not shown the directory', async () => {
    person({ isExternal: true });
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve(DIRECTORY));
    open('char');
    await waitFor(() => expect(state.api.searchNotes).toHaveBeenCalled());
    expect(state.api.getPeopleDirectory).not.toHaveBeenCalled();
  });
});

describe('Quick Actions in search', () => {
  it('"time off" offers Request Time Off, above Pages, and a pick runs it through the bolt', async () => {
    open('time off');
    expect(await screen.findByText('Request Time Off')).toBeTruthy();
    expect(sections()).toEqual(['Quick Actions']);
    fireEvent.click(screen.getByText('Request Time Off'));
    expect(takeQuickAction()).toEqual({ key: 'time-off', seed: null });
    expect(state.api.saveTaskTablePrefs).not.toHaveBeenCalled();   // an action is not a record
    expect(screen.queryByRole('button', { name: /Favorites/ })).toBeNull();
  });

  it('an action the person does not have is not offered', () => {
    person({}, ['dashboard', 'support']);                // no Workday
    open('time off');
    expect(screen.queryByText('Request Time Off')).toBeNull();
  });

  it('a typed action name leads; a word that only appears in one sits above Pages', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'New ticket printer', status: 'open', view: 'support' },
    ] }));
    open('new ti');
    await screen.findByText('New ticket printer');
    expect(sections()).toEqual(['Quick Actions', 'Tickets']);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(takeQuickAction()).toEqual({ key: 'ticket', seed: null });
    cleanup();

    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Support desk ticket', status: 'open', view: 'support' },
    ] }));
    open('ticket');
    await screen.findByText('Support desk ticket');
    expect(sections()).toEqual(['Tickets', 'Quick Actions']);
  });
});

describe('The sources stand alone', () => {
  it('one source failing never blanks the others', async () => {
    state.api.searchTicketsEverywhere = vi.fn(refused);
    state.api.searchDocumentLibrary = vi.fn(() => { throw new Error('boom'); });
    state.api.kbSearch = vi.fn(refused);
    state.api.searchNotes = vi.fn(() => Promise.resolve({ notes: [{ id: 'note_a1', kind: 'note', title: 'Gate repair plan', mine: true }] }));
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve([{ email: 'gates@x.com', name: 'Gates Morgan' }]));
    person({ canAccessModule: () => true }, [...EVERYONE, 'documents']);
    open('gate');
    expect(await screen.findByText('Gate repair plan')).toBeTruthy();
    expect(await screen.findByText('Gates Morgan')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull());
    expect(sections()).toEqual(['People', 'Notes']);
  });

  it('nothing is asked for one character, and a strange answer is no answer', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ enabled: false }));
    state.api.searchNotes = vi.fn(() => Promise.resolve(null));
    state.api.getPeopleDirectory = vi.fn(() => Promise.resolve({}));
    open('g');
    await new Promise((r) => setTimeout(r, 250));
    expect(state.api.searchNotes).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gz' } });
    await waitFor(() => expect(state.api.searchNotes).toHaveBeenCalledWith('gz', 5));
    expect(await screen.findByText('No results for “gz”')).toBeTruthy();
  });

  it('the arrow keys and Enter travel across the groups', async () => {
    state.api.searchTicketsEverywhere = vi.fn(() => Promise.resolve({ tickets: [
      { id: 'k1', code: '000041', subject: 'Gate ticket', status: 'open', view: 'support' },
    ] }));
    state.api.searchNotes = vi.fn(() => Promise.resolve({ notes: [{ id: 'note_a1', kind: 'note', title: 'Gate note', mine: true }] }));
    const nav = heard('nexus:navigate');
    open('gate');
    await screen.findByText('Gate ticket');
    await screen.findByText('Gate note');
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(nav.seen).toEqual([{ view: 'dashboard', sub: 'notes:note_a1' }]);
    nav.stop();
  });
});
