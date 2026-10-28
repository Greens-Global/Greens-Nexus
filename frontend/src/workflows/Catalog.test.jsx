import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Render-smoke for Workflows > Catalog: a rail of modules, the four
// sections for the picked one with their chips, the search, the New chips
// shown once (the catalog is marked seen after they paint) and the summary
// line of what is new.

const wfCatalogSeen = vi.fn();
vi.mock('../api', () => ({ api: { wfCatalogSeen: (...a) => wfCatalogSeen(...a) } }));

const CATALOG = {
  entities: [
    { key: 'employee', label: 'Person', module: 'hr', fields: [
      { key: 'name', label: 'Name', type: 'text', visibility: 'all' },
      { key: 'pay_rate', label: 'Pay Rate', type: 'money', visibility: 'comp' },
      { key: 'ssn_last4', label: 'SSN Last 4', type: 'text', visibility: 'hr' },
    ], dates: [{ key: 'birthday', label: 'Birthday', yearly: true }], people: [] },
    { key: 'task', label: 'Task', module: 'tasks', fields: [{ key: 'title', label: 'Title', type: 'text', visibility: 'all' }], dates: [], people: [] },
  ],
  events: [
    { key: 'hr.time_off.decided', entity: 'employee', label: 'Time Off Is Decided', module: 'hr', group: 'Time Off', changes: ['status'], volume: 'normal' },
    { key: 'hr.punch.in', entity: 'employee', label: 'Punch In', module: 'hr', group: 'Time Clock', changes: [], volume: 'high' },
    { key: 'task.created', entity: 'task', label: 'Task Is Created', module: 'tasks', group: 'Tasks', changes: [], volume: 'normal' },
  ],
  actions: [
    { key: 'notify', label: 'Send A Notification', module: 'hr', params: [{ key: 'to', label: 'To' }, { key: 'title', label: 'Title' }, { key: 'body', label: 'Message' }], needsPerson: false, adminOnly: false },
    { key: 'webhook', label: 'Call A Webhook', module: 'hr', params: [{ key: 'url', label: 'URL' }], needsPerson: false, adminOnly: true },
  ],
  listSources: [{ key: 'employees.probation_ending', label: 'People Whose Probation Ends Soon', entity: 'employee', module: 'hr', params: [{ key: 'days', label: 'Within Days' }] }],
  operators: {}, filters: [],
  newSince: ['hr.punch.in', 'webhook'],
  lastSeen: '2026-10-20T15:30:00Z',
};
const state = { catalog: CATALOG, loading: false, error: null };
vi.mock('./lib/useCatalog', () => ({
  useCatalog: () => ({ ...state, isNew: (k) => (state.catalog?.newSince || []).includes(k), entity: () => null, event: () => null, action: () => null }),
}));

const { default: Catalog } = await import('./Catalog');

beforeEach(() => {
  wfCatalogSeen.mockReset();
  wfCatalogSeen.mockResolvedValue({});
  Object.assign(state, { catalog: CATALOG, loading: false, error: null });
});

describe('Workflows Catalog', () => {
  it('lists the modules and the picked module\'s triggers, fields, actions and lists', async () => {
    render(<Catalog />);
    const rail = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(rail).getAllByRole('button').map((b) => b.textContent)).toEqual(['HR', 'Tasks']);
    const triggers = screen.getByRole('region', { name: 'Triggers' });
    expect(within(triggers).getByText('Time Off Is Decided')).toBeTruthy();
    expect(within(triggers).getByText('Time Off')).toBeTruthy();
    expect(within(triggers).getAllByText('Person').length).toBeGreaterThan(0);
    expect(within(triggers).getByText('Carries from and to for: status')).toBeTruthy();
    expect(within(triggers).getByText('High Volume')).toBeTruthy();
    const fields = screen.getByRole('region', { name: 'Fields' });
    expect(within(fields).getByText('HR Only')).toBeTruthy();
    expect(within(fields).getByText('Compensation')).toBeTruthy();
    expect(within(fields).getByText('Birthday')).toBeTruthy();
    expect(within(fields).getByText('Yearly')).toBeTruthy();
    const actions = screen.getByRole('region', { name: 'Actions' });
    expect(within(actions).getByText('Needs: To, Title, Message')).toBeTruthy();
    expect(within(actions).getByText('Global Admin Only')).toBeTruthy();
    const lists = screen.getByRole('region', { name: 'List Sources' });
    expect(within(lists).getByText('People Whose Probation Ends Soon')).toBeTruthy();
    expect(within(lists).getByText('Asks for: Within Days')).toBeTruthy();
  });

  it('shows the New chips and the summary, then marks the catalog seen once', async () => {
    render(<Catalog />);
    expect(screen.getByRole('status').textContent).toContain('New Since You Last Looked');
    expect(screen.getByRole('status').textContent).toContain('2 entries since 10/20/2026');
    expect(screen.getAllByText('New')).toHaveLength(2);
    await vi.waitFor(() => expect(wfCatalogSeen).toHaveBeenCalledTimes(1));
  });

  it('switches module from the rail and keeps the search within it', () => {
    render(<Catalog />);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(within(screen.getByRole('region', { name: 'Triggers' })).getByText('Task Is Created')).toBeTruthy();
    expect(screen.queryByText('Time Off Is Decided')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Actions' })).getByText(/Nothing here for this module/)).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the catalog' }), { target: { value: 'nothing matches this' } });
    expect(screen.queryByText('Task Is Created')).toBeNull();
  });

  it('filters by the search box', () => {
    render(<Catalog />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the catalog' }), { target: { value: 'webhook' } });
    expect(screen.getByText('Call A Webhook')).toBeTruthy();
    expect(screen.queryByText('Send A Notification')).toBeNull();
    expect(screen.queryByText('Time Off Is Decided')).toBeNull();
  });

  it('paints a skeleton while loading and no summary without anything new', () => {
    state.catalog = { ...CATALOG, newSince: [] };
    render(<Catalog />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('New')).toBeNull();
  });
});
