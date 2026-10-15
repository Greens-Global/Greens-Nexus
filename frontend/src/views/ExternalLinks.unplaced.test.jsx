// A link added after the person arranged their Links (Neil, Oct 14 2026):
// the grid used to list only what the saved layout places, so a link added
// from Manage > Add Link stayed hidden until a page reload (when the server
// appends missing Company Links) - and a new Personal Link on an arranged
// Personal tab never showed at all. Every live link the layout has not
// placed now shows after the arranged ones, at once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const company = [
  { id: 1, name: 'Payroll Portal', url: 'https://payroll.example.com', categories: ['HR'], departments: [], companies: [], sort_order: 10 },
  { id: 2, name: 'Site Cameras', url: 'https://cams.example.com', categories: ['Operations'], departments: [], companies: [], sort_order: 20 },
  { id: 3, name: 'Brand New Tool', url: 'https://new.example.com', categories: ['Operations'], departments: [], companies: [], sort_order: 30 },
];

const view = (items, folders = []) => ({
  views: [{ id: 'v1', name: 'My view', isDefault: true, layout: { folders, items, favorites: [], filters: {} } }],
});

const apiMock = vi.hoisted(() => ({}));
vi.mock('../api', () => ({
  api: new Proxy(apiMock, {
    get: (target, k) => (k in target ? target[k] : () => Promise.resolve(null)),
  }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ myEmail: 'neil@greensglobal.com', canAccessModule: () => true, myRole: 'admin', can: () => true }),
}));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));

const { default: ExternalLinks } = await import('./ExternalLinks');

beforeEach(() => {
  localStorage.clear();
  apiMock.getExternalLinks = vi.fn(async () => company);
  apiMock.getExternalLinksMeta = vi.fn(async () => ({ departments: [], categories: [] }));
  apiMock.getExternalLinksTaxonomy = vi.fn(async () => ({ departments: [], categories: [] }));
  apiMock.getPersonalLinks = vi.fn(async () => []);
});

describe('a link the saved layout has not placed yet', () => {
  it('shows on an arranged tab, after the arranged ones', async () => {
    // Arranged before link 3 existed: Site Cameras first, then Payroll Portal.
    apiMock.listLinkViews = vi.fn(async () => view([
      { item_type: 'external', item_id: 2, folder_id: null, position: 0 },
      { item_type: 'external', item_id: 1, folder_id: null, position: 1 },
    ]));
    render(<ExternalLinks />);

    const added = await screen.findByText('Brand New Tool');
    const cameras = screen.getByText('Site Cameras');
    const payroll = screen.getByText('Payroll Portal');
    // The arranged order is kept, and the new link comes last.
    expect(cameras.compareDocumentPosition(payroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(payroll.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not shown twice when the layout already has it inside a folder', async () => {
    apiMock.listLinkViews = vi.fn(async () => view(
      [
        { item_type: 'external', item_id: 1, folder_id: null, position: 0 },
        { item_type: 'external', item_id: 2, folder_id: null, position: 1 },
        { item_type: 'external', item_id: 3, folder_id: 'f1', position: 0 },
      ],
      [{ id: 'f1', name: 'Ops Tools', position: 0, item_type: 'external' }],
    ));
    render(<ExternalLinks />);

    const folder = await screen.findByText('Ops Tools');
    expect(folder).toBeTruthy();
    // A folder tile shows its members as icons only, so the name appearing at
    // all would mean a second, top-level copy of it.
    expect(screen.getByText('Payroll Portal')).toBeTruthy();
    expect(screen.queryByText('Brand New Tool')).toBeNull();
  });
});
