import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

// Help > Keyboard Shortcuts (11/13/2026): one entry on the Help panel's Home
// that opens the list inside the panel, and Back returns to Help.
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, accounts: [{ name: 'Pranshu Pandey', username: 'pranshu@example.com' }] }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'pranshu@example.com' }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));

const { default: HelpMenu, __resetHelpTab } = await import('./HelpMenu');
await import('./HelpWidget');   // warm the lazy chunk

const LOAD = { timeout: 8000 };
const phone = { on: false };
beforeEach(() => {
  __resetHelpTab();
  phone.on = false;
  window.matchMedia = (q) => ({ matches: phone.on && /max-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

const openWidget = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Help' })); await new Promise((r) => { setTimeout(r, 0); }); });
  const d = await screen.findByRole('dialog', { name: 'Help' }, LOAD);
  await within(d).findByRole('tablist', {}, LOAD);
  return d;
};

describe('Help - Keyboard Shortcuts', () => {
  it('Home offers Keyboard Shortcuts; it opens the grouped list in the panel and Back returns', async () => {
    render(<HelpMenu activeView="dashboard" />);
    const d = await openWidget();
    fireEvent.click(within(d).getByRole('button', { name: /Keyboard Shortcuts/ }));
    expect(within(d).getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeTruthy();
    expect(within(d).getByRole('region', { name: 'Everywhere' })).toBeTruthy();
    expect(within(d).getByText('Search Nexus')).toBeTruthy();
    expect(within(d).getByText('Quick Note')).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: /Back/ }));
    expect(within(d).queryByRole('heading', { name: 'Keyboard Shortcuts' })).toBeNull();
    expect(within(d).getByLabelText('Search for help')).toBeTruthy();   // the Help tab it came back to
  });

  it('is not offered on a phone', async () => {
    phone.on = true;
    render(<HelpMenu activeView="dashboard" />);
    const d = await openWidget();
    expect(within(d).queryByRole('button', { name: /Keyboard Shortcuts/ })).toBeNull();
  });
});
