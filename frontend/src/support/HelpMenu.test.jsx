import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

// The header "?" Help menu: opens from its button, from the "?" key (never
// while typing), and from the phone menu's event; searches the guide; offers
// help for the current page; and closes on Esc / outside click.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const role = { admin: false, grants: new Set() };
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({
    isExternal: false,
    can: (r) => role.admin && r === 'administrator',
    myGrantedModules: role.grants,
  }),
}));

const HelpMenu = (await import('./HelpMenu')).default;
const { HELP_OPEN_EVENT } = await import('./HelpMenu');

afterEach(() => { cleanup(); Object.assign(role, { admin: false, grants: new Set() }); });

const openByButton = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Help' }));
  return screen.findByLabelText('Search help', {}, { timeout: 8000 });
};

describe('Help menu', () => {
  it('has an accessible Help button in the header', () => {
    render(<HelpMenu activeView="dashboard" />);
    const btn = screen.getByRole('button', { name: 'Help' });
    expect(btn.getAttribute('title')).toBe('Help');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens from the button and shows results for a query', async () => {
    render(<HelpMenu activeView="dashboard" />);
    const input = await openByButton();
    expect(screen.getByRole('button', { name: 'Help' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(input, { target: { value: 'how do i request pto' } });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toContain('Request Time Off');
  });

  it('shows a plain message, not noise, for junk', async () => {
    render(<HelpMenu activeView="dashboard" />);
    const input = await openByButton();
    fireEvent.change(input, { target: { value: 'banana smoothie recipe' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No articles match/)).toBeTruthy();
    // Contact Support is always there as the way out.
    expect(screen.getByText('Contact Support')).toBeTruthy();
  });

  it('opens with the ? key, but not while typing in a field', async () => {
    render(<><input aria-label="Other field" /><HelpMenu activeView="dashboard" /></>);
    const other = screen.getByLabelText('Other field');
    other.focus();
    fireEvent.keyDown(other, { key: '?' });
    expect(screen.queryByLabelText('Search help')).toBeNull();
    other.blur();
    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByLabelText('Search help', {}, { timeout: 8000 })).toBeTruthy();
  });

  it('opens from the phone menu event', async () => {
    render(<HelpMenu activeView="dashboard" />);
    act(() => { window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT)); });
    expect(await screen.findByLabelText('Search help', {}, { timeout: 8000 })).toBeTruthy();
  });

  it('closes on Escape and on an outside click', async () => {
    render(<><button type="button">Elsewhere</button><HelpMenu activeView="dashboard" /></>);
    const input = await openByButton();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Search help')).toBeNull();
    await openByButton();
    fireEvent.mouseDown(screen.getByText('Elsewhere'));
    expect(screen.queryByLabelText('Search help')).toBeNull();
  });

  it('offers help for the current page and its tour', async () => {
    render(<HelpMenu activeView="support" />);
    await openByButton();
    expect(screen.getByText('Help for This Page')).toBeTruthy();
    expect(screen.getByText('Submit a Ticket')).toBeTruthy();
    expect(screen.getByText('Take a Tour')).toBeTruthy();
    expect(screen.getByText('Getting Started')).toBeTruthy();
    expect(screen.getByText('Browse All Documentation')).toBeTruthy();
  });

  it('has no tour link where the page has no tour, and no page help for a page it cannot see', async () => {
    render(<HelpMenu activeView="accounting" />);
    await openByButton();
    expect(screen.queryByText('Take a Tour')).toBeNull();
    // An employee without the Accounting grant gets no Accounting guide.
    expect(screen.queryByText('Help for This Page')).toBeNull();
  });

  it('picking a result navigates to the documentation section', async () => {
    const navs = [];
    const onNav = (e) => navs.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<HelpMenu activeView="dashboard" />);
    const input = await openByButton();
    fireEvent.change(input, { target: { value: 'request time off' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    window.removeEventListener('nexus:navigate', onNav);
    expect(navs).toEqual([{ view: 'support', sub: 'documentation' }]);
    expect(screen.queryByLabelText('Search help')).toBeNull();
  });

  it('Contact Support goes to the Help Center, not straight to a new ticket', async () => {
    const navs = [];
    const onNav = (e) => navs.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<HelpMenu activeView="dashboard" />);
    await openByButton();
    fireEvent.click(screen.getByText('Contact Support'));
    window.removeEventListener('nexus:navigate', onNav);
    expect(navs).toEqual([{ view: 'support' }]);
  });

  it("What's New uses the header's changelog opener", async () => {
    const onWhatsNew = vi.fn();
    render(<HelpMenu activeView="dashboard" onWhatsNew={onWhatsNew} />);
    await openByButton();
    fireEvent.click(screen.getByText("What's New"));
    expect(onWhatsNew).toHaveBeenCalledTimes(1);
  });
});
