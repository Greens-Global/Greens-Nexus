// Links departments (Neil, Oct 21 2026): the screen opens on the viewer's
// own department (from their People record), with the company-wide links
// always in; "Storage" reads as "Operations" wherever it was stored; Human
// Resources and Marketing are departments; the pick is remembered per
// account in this browser.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const ME = 'neil@greensglobal.com';
const links = [
  { id: 1, name: 'Outlook', url: 'https://outlook.example.com', categories: [], departments: [], companies: [], sort_order: 10 },
  { id: 2, name: 'Ramp', url: 'https://ramp.example.com', categories: [], departments: ['Accounting'], companies: [], sort_order: 20 },
  { id: 3, name: 'Cubby', url: 'https://cubby.example.com', categories: [], departments: ['Storage'], companies: [], sort_order: 30 },
  { id: 4, name: 'Benefits Portal', url: 'https://benefits.example.com', categories: [], departments: ['Human Resources'], companies: [], sort_order: 40 },
];
const taxonomy = {
  departments: [
    { id: 'a', kind: 'department', name: 'Accounting' }, { id: 's', kind: 'department', name: 'Storage' },
    { id: 'i', kind: 'department', name: 'IT' }, { id: 'h', kind: 'department', name: 'Human Resources' },
    { id: 'm', kind: 'department', name: 'Marketing' },
  ],
  categories: [],
};
const directory = (department) => [
  { email: 'someone@greensglobal.com', name: 'Someone Else', company: 'gg', companyName: 'Greens Global', department: 'Accounting' },
  { email: ME, name: 'Neil Kadakia', company: 'gg', companyName: 'Greens Global', department },
];

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

const departmentSelect = () => screen.getByLabelText('Department');
const optionLabels = () => [...departmentSelect().options].map(o => o.textContent);

beforeEach(() => {
  localStorage.clear();
  apiMock.getExternalLinks = vi.fn(async () => links);
  apiMock.getExternalLinksMeta = vi.fn(async () => ({ departments: ['Accounting', 'Storage', 'Human Resources'], categories: [] }));
  apiMock.getExternalLinksTaxonomy = vi.fn(async () => taxonomy);
  apiMock.getPersonalLinks = vi.fn(async () => []);
  apiMock.listLinkViews = vi.fn(async () => ({ views: [] }));
  apiMock.saveLinkLayout = vi.fn(async () => ({}));
  apiMock.getPeopleDirectory = vi.fn(async () => directory('Ops'));
});

describe('the department list', () => {
  it('says Operations, never Storage, lists the two new departments and is alphabetical', async () => {
    render(<ExternalLinks />);
    await screen.findByText('Outlook');
    await waitFor(() => expect(optionLabels()).toContain('Operations'));
    const labels = optionLabels();
    expect(labels[0]).toBe('All Departments');
    expect(labels).not.toContain('Storage');
    expect(labels).toContain('Human Resources');
    expect(labels).toContain('Marketing');
    expect(labels.slice(1)).toEqual([...labels.slice(1)].sort((a, b) => a.localeCompare(b)));
  });
});

describe('the default department', () => {
  it('opens on the viewer\'s own department, with the company-wide links still in', async () => {
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Operations'));
    expect(screen.getByText('Cubby')).toBeTruthy();         // tagged Storage, now Operations
    expect(screen.getByText('Outlook')).toBeTruthy();       // no department: everyone's
    expect(screen.queryByText('Ramp')).toBeNull();          // Accounting only
    expect(apiMock.saveLinkLayout).not.toHaveBeenCalled();  // opening the screen writes nothing
  });

  it('matches "HR" on a People record to Human Resources', async () => {
    apiMock.getPeopleDirectory = vi.fn(async () => directory('HR'));
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Human Resources'));
    expect(screen.getByText('Benefits Portal')).toBeTruthy();
    expect(screen.queryByText('Cubby')).toBeNull();
  });

  it('shows every department when the viewer has no department on record', async () => {
    apiMock.getPeopleDirectory = vi.fn(async () => directory(''));
    render(<ExternalLinks />);
    await screen.findByText('Ramp');
    expect(departmentSelect().value).toBe('');
    expect(screen.getByText('Cubby')).toBeTruthy();
    expect(screen.getByText('Benefits Portal')).toBeTruthy();
  });

  it('shows every department when the viewer is not in the directory at all', async () => {
    apiMock.getPeopleDirectory = vi.fn(async () => directory('Ops').slice(0, 1));
    render(<ExternalLinks />);
    await screen.findByText('Ramp');
    expect(departmentSelect().value).toBe('');
  });

  it('shows every department when the viewer\'s department has no links yet', async () => {
    apiMock.getPeopleDirectory = vi.fn(async () => directory('Marketing'));
    render(<ExternalLinks />);
    await screen.findByText('Ramp');
    expect(departmentSelect().value).toBe('');
  });

  it('prefers the department last picked in this browser, read as its current name', async () => {
    localStorage.setItem(`nexus-links-dept:${ME}`, 'Storage');
    apiMock.getPeopleDirectory = vi.fn(async () => directory('Accounting'));
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Operations'));
    expect(screen.getByText('Cubby')).toBeTruthy();
    expect(screen.queryByText('Ramp')).toBeNull();
  });

  it('keeps All Departments when that is what the viewer chose last time', async () => {
    localStorage.setItem(`nexus-links-dept:${ME}`, '');
    render(<ExternalLinks />);
    await screen.findByText('Ramp');
    expect(departmentSelect().value).toBe('');
    expect(screen.getByText('Cubby')).toBeTruthy();
  });

  it('keeps a saved view\'s own filter, and reads a saved "Storage" as Operations', async () => {
    apiMock.listLinkViews = vi.fn(async () => ({
      views: [{ id: 'v1', name: 'My view', isDefault: true, layout: { folders: [], items: [], favorites: [], filters: { department: 'Storage' } } }],
    }));
    apiMock.getPeopleDirectory = vi.fn(async () => directory('Accounting'));
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Operations'));
    expect(screen.getByText('Cubby')).toBeTruthy();
    expect(screen.queryByText('Ramp')).toBeNull();
  });
});

describe('picking a department', () => {
  it('is remembered for this account and saved into the view', async () => {
    // Like the server: the first filter change on Home creates the default
    // view, and the reload that follows brings that view (filter included) back.
    let saved = null;
    apiMock.saveLinkLayout = vi.fn(async (layout) => { saved = layout; return {}; });
    apiMock.listLinkViews = vi.fn(async () => ({ views: saved ? [{ id: 'v1', name: 'My view', isDefault: true, layout: saved }] : [] }));
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Operations'));
    fireEvent.change(departmentSelect(), { target: { value: 'Accounting' } });
    await waitFor(() => expect(apiMock.saveLinkLayout).toHaveBeenCalled());
    expect(apiMock.saveLinkLayout.mock.calls[0][0].filters.department).toBe('Accounting');
    expect(localStorage.getItem(`nexus-links-dept:${ME}`)).toBe('Accounting');
    await screen.findByText('Ramp');
    expect(screen.queryByText('Cubby')).toBeNull();
  });

  it('All Departments is one pick away and sticks', async () => {
    render(<ExternalLinks />);
    await waitFor(() => expect(departmentSelect().value).toBe('Operations'));
    fireEvent.change(departmentSelect(), { target: { value: '' } });
    await screen.findByText('Ramp');
    expect(departmentSelect().value).toBe('');
    expect(localStorage.getItem(`nexus-links-dept:${ME}`)).toBe('');
  });
});
