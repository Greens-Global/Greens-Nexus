// Render-smoke for the dashboard's link widgets (Sep 24): Favorites, My
// Personal Links, and the configurable Quick Actions tile. A crash-on-render
// here would blank a saved dashboard view for everyone who added the tile,
// so the tests pin the three things a user actually sees - resolved
// favorites tiles, the Add tile + empty hint, and which actions a config
// picks - plus that a pre-config Quick Actions tile still shows its six.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const company = [
  { id: 1, name: 'Payroll Portal', url: 'https://payroll.example.com', category: 'HR' },
  { id: 2, name: 'Site Cameras', url: 'https://cams.example.com', category: 'Operations' },
];
const personal = [
  { id: 1, name: 'My Bank', url: 'https://bank.example.com', sort_order: 2 },
  { id: 7, name: 'Lunch Menu', url: 'https://lunch.example.com', sort_order: 1 },
];
const layout = {
  folders: [], items: [],
  favorites: [
    { item_type: 'external', item_id: 2 },
    { item_type: 'personal', item_id: 1 },
    { item_type: 'external', item_id: 999 }, // deleted link - must be skipped, not crash
  ],
};

// vi.mock factories are hoisted above every import, so the mock object they
// close over has to be hoisted too or it is read before initialization.
const apiMock = vi.hoisted(() => ({
  getLinkLayout: vi.fn(),
  getExternalLinks: vi.fn(),
  getPersonalLinks: vi.fn(),
  clickExternalLink: vi.fn(async () => ({})),
  clickPersonalLink: vi.fn(async () => ({})),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import { WIDGETS, DEFAULT_QUICK_ACTIONS, QUICK_ACTIONS, resolveQuickActions } from './widgets.jsx';
import { configValid } from './WidgetGallery.jsx';

const mount = (type, config = {}) => {
  const Comp = WIDGETS[type].render;
  return render(<Comp config={config} updateConfig={vi.fn()} kpis={{}} />);
};

beforeEach(() => {
  localStorage.clear();
  window.open = vi.fn();
  apiMock.getLinkLayout.mockResolvedValue(layout);
  apiMock.getExternalLinks.mockResolvedValue(company);
  apiMock.getPersonalLinks.mockResolvedValue(personal);
});

describe('Favorites widget', () => {
  it('resolves saved favorites against Company and Personal links and skips deleted ones', async () => {
    mount('favorites');
    expect(await screen.findByText('Site Cameras')).toBeTruthy();
    expect(screen.getByText('My Bank')).toBeTruthy();
    expect(screen.queryByText('Payroll Portal')).toBeNull();
  });

  it('opens a favorite in a new tab, records the click and feeds Recently Used', async () => {
    mount('favorites');
    fireEvent.click(await screen.findByText('Site Cameras'));
    expect(window.open).toHaveBeenCalledWith('https://cams.example.com', '_blank', 'noopener,noreferrer');
    expect(apiMock.clickExternalLink).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Recent' }));
    expect(await screen.findByText('Recently Used')).toBeTruthy();
    expect(screen.getByText('Site Cameras')).toBeTruthy();
  });

  it('shows the bookmark hint when nothing is favorited', async () => {
    apiMock.getLinkLayout.mockResolvedValueOnce({ folders: [], items: [], favorites: [] });
    mount('favorites');
    expect(await screen.findByText(/No favorites yet/)).toBeTruthy();
  });
});

describe('My Personal Links widget', () => {
  it('lists the links in sort order with an Add tile and the paste hint', async () => {
    mount('personal-links');
    const lunch = await screen.findByText('Lunch Menu');
    const bank = screen.getByText('My Bank');
    expect(lunch.compareDocumentPosition(bank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Add Link')).toBeTruthy();
    expect(screen.getByText(/Ctrl\+V/)).toBeTruthy();
  });

  it('still renders the Add tile when the user has no links yet', async () => {
    apiMock.getPersonalLinks.mockResolvedValueOnce([]);
    mount('personal-links');
    expect(await screen.findByText('Add Link')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  });
});

describe('Quick Actions tile', () => {
  it('keeps the original six actions when a tile has no config', () => {
    mount('quick-actions');
    for (const key of DEFAULT_QUICK_ACTIONS) {
      expect(screen.getByText(QUICK_ACTIONS.find(a => a.key === key).label)).toBeTruthy();
    }
    expect(screen.queryByText('Add Personal Link')).toBeNull();
  });

  it('shows only the picked actions, in catalog order', () => {
    mount('quick-actions', { actions: ['kb', 'personal-link'] });
    const rows = screen.getAllByRole('button').map(b => b.textContent.trim());
    expect(rows).toEqual(['Add Personal Link', 'Knowledge Base']);
  });

  it('config helpers: unknown keys are dropped and an empty pick is invalid', () => {
    expect(resolveQuickActions({ actions: ['bogus', 'task'] }).map(a => a.key)).toEqual(['task']);
    expect(configValid('quick-actions', {})).toBe(true);
    expect(configValid('quick-actions', { actions: [] })).toBe(false);
    expect(configValid('links-folder', {})).toBe(false);
  });
});
