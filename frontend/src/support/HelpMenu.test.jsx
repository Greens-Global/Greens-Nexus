import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

// The Help widget behind the header "?": Home (greeting + three cards),
// Help (one search over the guide, Knowledge Base documents and courses) and
// Messages (your tickets). Opens from the button, the "?" key and the phone
// menu's event; Esc closes it and returns focus to the button.

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pranshu Pandey', username: 'pranshu@example.com' }] }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'pranshu@example.com' }),
}));

const KB_DOCS = [
  { id: 'kb1', title: 'Forklift Safety Procedure', status: 'approved', doc_type: 'SOP', departments: ['Operations'],
    service: '', tags: ['safety'], body: { purpose: 'How to operate the warehouse forklift safely.' },
    content_text: 'Inspect the forklift before every shift. Wear a seat belt.' },
  { id: 'kb2', title: 'Forklift Draft Checklist', status: 'draft', doc_type: 'SOP', departments: [], body: {}, content_text: 'forklift' },
];
const KB_COURSES = [
  { id: 'crs1', title: 'Forklift Operator Training', status: 'published', description: 'Certification course for forklift drivers.',
    overview: [], departments: ['Operations'], est_minutes: 20, lesson_count: 4 },
  { id: 'crs2', title: 'Forklift Advanced (Draft)', status: 'draft', description: 'forklift', overview: [], departments: [] },
];
const TICKETS = [
  { id: 't1', code: 'TKT-000012', subject: 'VPN keeps dropping', status: 'in_progress', createdAt: '2026-09-20T10:00:00Z', modifiedAt: '2026-09-25T15:00:00Z' },
  { id: 't2', code: 'TKT-000009', subject: 'New monitor request', status: 'resolved', createdAt: '2026-09-01T10:00:00Z', modifiedAt: '2026-09-02T10:00:00Z' },
];

const apiState = { kbFail: false, tickets: TICKETS };
vi.mock('../api', () => {
  const handlers = {
    getKbDocs: () => (apiState.kbFail ? Promise.reject(new Error('down')) : Promise.resolve(KB_DOCS)),
    getKbCourses: () => (apiState.kbFail ? Promise.reject(new Error('down')) : Promise.resolve(KB_COURSES)),
    getMyTickets: () => Promise.resolve(apiState.tickets),
  };
  return { api: new Proxy(handlers, { get: (t, k) => t[k] || (() => Promise.resolve([])) }) };
});

const { default: HelpMenu, HELP_OPEN_EVENT, __resetHelpTab } = await import('./HelpMenu');
const { __resetKbCorpus } = await import('./kbCorpus');
// Warm the lazy widget chunk so the first test is not timed on the transform.
await import('./HelpWidget');

beforeEach(() => { apiState.kbFail = false; apiState.tickets = TICKETS; __resetKbCorpus(); __resetHelpTab(); });
afterEach(() => { cleanup(); });

const LOAD = { timeout: 8000 };
const openWidget = async () => {
  // act() lets React retry the lazy widget once its chunk resolves.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Help' })); await new Promise((r) => { setTimeout(r, 0); }); });
  return screen.findByRole('dialog', { name: 'Help' }, LOAD).then(async (d) => {
    await within(d).findByRole('tablist', {}, LOAD);
    return d;
  });
};
const goToHelpSearch = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Search for Help/ }, LOAD));
  return screen.findByLabelText('Search for help', {}, LOAD);
};

describe('Help widget', () => {
  it('has an accessible Help button in the header', () => {
    render(<HelpMenu activeView="dashboard" />);
    const btn = screen.getByRole('button', { name: 'Help' });
    expect(btn.getAttribute('title')).toBe('Help');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on Home with the greeting and the three cards', async () => {
    render(<HelpMenu activeView="dashboard" onWhatsNew={() => {}} />);
    await openWidget();
    expect(screen.getByText('Hi Pranshu')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How can we help?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Search for Help/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ask a Question.*Our support team can help/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /What's New in Nexus/ })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Home', 'Messages', 'Help']);
    // No AI wording anywhere (the user asked for none).
    expect(document.body.textContent).not.toMatch(/\bAI\b/);
  });

  it('Search for Help goes to the Help tab with the search box focused', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('tab', { name: /Help/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('a query returns guide, Knowledge Base and course results, labeled by source', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(input, { target: { value: 'forklift' } });
    const list = await screen.findByRole('list', { name: 'Help results' });
    const text = list.textContent;
    expect(text).toContain('Forklift Safety Procedure');
    expect(text).toContain('Forklift Operator Training');
    expect(text).toContain('Knowledge Base');
    expect(text).toContain('Course');
    // Drafts never show, even though the list endpoint returns them to authors.
    expect(text).not.toContain('Draft');

    fireEvent.change(input, { target: { value: 'request time off' } });
    const guide = await screen.findByRole('list', { name: 'Help results' });
    expect(guide.textContent).toContain('Request Time Off');
    expect(guide.textContent).toContain('Guide');
  });

  it('junk returns nothing', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    fireEvent.change(input, { target: { value: 'banana smoothie recipe' } });
    expect(screen.queryByRole('list', { name: 'Help results' })).toBeNull();
    expect(screen.getByText(/No results for/)).toBeTruthy();
  });

  it('a Knowledge Base failure still shows guide results, with a quiet note', async () => {
    apiState.kbFail = true;
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    fireEvent.change(input, { target: { value: 'how do i request pto' } });
    expect((await screen.findByRole('list', { name: 'Help results' })).textContent).toContain('Request Time Off');
    expect(screen.getByRole('status').textContent).toMatch(/Knowledge Base results are unavailable/);
  });

  it('a guide result opens inside the widget, with a way to the full page', async () => {
    const navs = [];
    const onNav = (e) => navs.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    fireEvent.change(input, { target: { value: 'request time off' } });
    fireEvent.click(within(await screen.findByRole('list', { name: 'Help results' })).getAllByRole('button')[0]);
    expect(screen.getByRole('heading', { name: 'Request Time Off' })).toBeTruthy();
    expect(screen.getByText('Click the Time Off tab.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open in Documentation/ }));
    window.removeEventListener('nexus:navigate', onNav);
    expect(navs).toEqual([{ view: 'support', sub: 'documentation' }]);
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('a Knowledge Base result opens it in the Knowledge Base', async () => {
    const navs = [];
    const onNav = (e) => navs.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    const input = await goToHelpSearch();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(input, { target: { value: 'forklift operator training' } });
    fireEvent.click(await screen.findByRole('button', { name: /Forklift Operator Training/ }));
    window.removeEventListener('nexus:navigate', onNav);
    expect(navs).toEqual([{ view: 'sop', sub: 'lms' }]);
  });

  it('with no search, lists the guide to browse, Getting Started first', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    await goToHelpSearch();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    const gs = buttons.findIndex((t) => t.startsWith('Getting Started'));
    expect(gs).toBeGreaterThan(-1);
    expect(buttons.findIndex((t) => t === 'Workday')).toBeGreaterThan(gs);
    // An employee does not browse modules they cannot open.
    expect(buttons).not.toContain('Accounting');
  });

  it('Messages lists your tickets', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    fireEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    const list = await screen.findByRole('list', { name: 'Your tickets' });
    const rows = within(list).getAllByRole('button');
    expect(rows[0].textContent).toContain('VPN keeps dropping');
    expect(rows[0].textContent).toContain('In progress');
    expect(rows[0].textContent).toContain('09/25/2026');
    expect(screen.getByRole('button', { name: /Send Us a Message/ })).toBeTruthy();
  });

  it('Messages shows an empty state when there are none', async () => {
    apiState.tickets = [];
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    fireEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    expect(await screen.findByText('No Messages Yet')).toBeTruthy();
  });

  it('opening a ticket goes to Support and asks it to open that ticket', async () => {
    const navs = []; const opened = [];
    const onNav = (e) => navs.push(e.detail);
    const onOpen = (e) => opened.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    window.addEventListener('nexus:open-ticket', onOpen);
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    fireEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    fireEvent.click(await screen.findByRole('button', { name: /VPN keeps dropping/ }));
    await act(() => new Promise((r) => { setTimeout(r, 5); }));
    window.removeEventListener('nexus:navigate', onNav);
    window.removeEventListener('nexus:open-ticket', onOpen);
    expect(navs).toEqual([{ view: 'support' }]);
    expect(opened).toEqual([{ ticketId: 't1' }]);
  });

  it('Esc closes the widget and returns focus to the Help button', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Help' }));
  });

  it('closes on a click outside', async () => {
    render(<><button type="button">Elsewhere</button><HelpMenu activeView="dashboard" /></>);
    await openWidget();
    fireEvent.mouseDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
  });

  it('opens with the ? key, but not while typing in a field, and from the phone menu event', async () => {
    render(<><input aria-label="Other field" /><HelpMenu activeView="dashboard" /></>);
    const other = screen.getByLabelText('Other field');
    other.focus();
    fireEvent.keyDown(other, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    other.blur();
    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Help' }, LOAD)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT)); });
    expect(await screen.findByRole('dialog', { name: 'Help' }, LOAD)).toBeTruthy();
  });

  it('remembers the last tab for the session', async () => {
    render(<HelpMenu activeView="dashboard" />);
    await openWidget();
    fireEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await openWidget();
    expect(screen.getByRole('tab', { name: /Messages/ }).getAttribute('aria-selected')).toBe('true');
  });

  it("What's New uses the header's changelog opener", async () => {
    const onWhatsNew = vi.fn();
    render(<HelpMenu activeView="dashboard" onWhatsNew={onWhatsNew} />);
    await openWidget();
    fireEvent.click(screen.getByRole('button', { name: /What's New in Nexus/ }));
    expect(onWhatsNew).toHaveBeenCalledTimes(1);
  });
});
