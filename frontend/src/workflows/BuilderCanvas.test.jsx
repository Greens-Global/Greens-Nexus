// The builder's two views (10/30/2026): the canvas opens by default on a
// desktop, the Recipe button swaps to the prose cards and the choice is
// kept, a kept Recipe choice opens the recipe, a phone never shows the
// toggle, and a block selected on the canvas opens in the side panel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const catalog = {
  entities: [{ key: 'employee', label: 'Person', module: 'hr', fields: [{ key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }], visibility: 'all' }], dates: [], people: [{ key: 'manager', label: 'Their Manager' }] }],
  events: [{ key: 'hr.employee.status_changed', entity: 'employee', label: 'Status Changes', module: 'hr', group: 'People', changes: ['status'], volume: 'normal' }],
  actions: [{ key: 'notify', label: 'Send A Notification', module: 'core', params: [{ key: 'to', label: 'To', type: 'recipients', required: true }, { key: 'title', label: 'Title', type: 'template', required: true }] }],
  listSources: [], operators: { select: [{ key: 'is', label: 'is' }] }, filters: [], newSince: [],
};
const definition = {
  v: 1,
  trigger: { kind: 'event', event: 'hr.employee.status_changed', filters: [] },
  conditions: [[{ field: 'status', op: 'is', value: 'active' }]],
  steps: [{ id: 's1', kind: 'action', action: 'notify', params: { to: [{ kind: 'manager' }], title: 'Welcome {{ subject.name }}' }, enabled: true }],
  settings: { oncePerSubject: false, cooldownHours: 0, suppress: { people: [], companies: [] }, logSkips: false, allowDownstream: false, maxRunsPerHour: 100, maxRecipients: 50, onError: 'stop', faultSteps: [] },
};
const workflow = { id: 'w1', name: 'Welcome Note', ownerEmail: 'neil@greensglobal.com', ownerName: 'Neil Kadakia', runAs: 'owner', companyId: '', status: 'active', version: 2, definition, draft: null, testedCurrent: true, problems: [] };

const api = {
  wfGet: vi.fn(() => Promise.resolve(workflow)), wfSaveDraft: vi.fn(() => Promise.resolve({})), wfVersions: vi.fn(() => Promise.resolve([])),
  wfRecentEvents: vi.fn(() => Promise.resolve([])), getPeopleDirectory: vi.fn(() => Promise.resolve([])), wfPreviewSchedule: vi.fn(() => Promise.resolve({ count: 0, items: [] })),
};
vi.mock('../api', () => ({ api }));
vi.mock('./lib/useCatalog', () => ({ useCatalog: () => ({ catalog, loading: false, error: null, isNew: () => false }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myRole: 'owner', myEmail: 'neil@greensglobal.com', companies: [], canAccessModule: () => true }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)), alert: vi.fn(() => Promise.resolve()) } }));

const { default: Builder } = await import('./Builder');

const realMatchMedia = window.matchMedia;
const phone = (on) => { window.matchMedia = (q) => ({ matches: on && q.includes('640'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); };

beforeEach(() => { window.localStorage.clear(); phone(false); });
afterEach(() => { window.matchMedia = realMatchMedia; });

const open = async () => {
  render(<Builder id="w1" go={vi.fn()} />);
  await screen.findByDisplayValue('Welcome Note');
};

describe('Builder views', () => {
  it('opens on the canvas by default on a desktop, with the trigger listening and the rail in the side panel', async () => {
    await open();
    expect(screen.getByTestId('wfc')).toHaveAttribute('data-skin', 'paper');
    const trigger = screen.getByRole('button', { name: /^Trigger: .*Status Changes/i });
    expect(trigger).toHaveClass('is-listening');
    expect(screen.getByRole('button', { name: /^Action: Send A Notification/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Do' })).toBeNull();
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Canvas' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to the recipe and remembers it', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Recipe' }));
    expect(screen.getByRole('region', { name: 'Do' })).toBeInTheDocument();
    expect(screen.queryByTestId('wfc')).toBeNull();
    expect(window.localStorage.getItem('wf-builder-view')).toBe('recipe');
  });

  it('opens on the recipe when that is what the person last used, and switches to the canvas', async () => {
    window.localStorage.setItem('wf-builder-view', 'recipe');
    await open();
    expect(screen.getByRole('region', { name: 'Do' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
    expect(screen.getByTestId('wfc')).toBeInTheDocument();
    expect(window.localStorage.getItem('wf-builder-view')).toBe('canvas');
  });

  it('keeps the recipe on a phone, with no view toggle', async () => {
    phone(true);
    await open();
    expect(screen.getByRole('region', { name: 'Do' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Canvas' })).toBeNull();
    expect(screen.queryByTestId('wfc')).toBeNull();
  });

  it('opens a selected block in the side panel and edits the definition from there', async () => {
    await open();
    const node = screen.getByRole('button', { name: /^Action: Send A Notification/i });
    act(() => { node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 11 })); });
    expect(await screen.findByRole('complementary', { name: 'Action step' })).toBeInTheDocument();
    expect(node).toHaveClass('is-selected');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Action: Skipped: Send A Notification/i })).toHaveClass('is-skipped'));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Action step' })).toBeNull());
    expect(screen.getByRole('tab', { name: /Settings/ })).toBeInTheDocument();
  });

  it('switches the canvas skin and remembers it', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(screen.getByTestId('wfc')).toHaveAttribute('data-skin', 'night');
    expect(window.localStorage.getItem('wf-canvas-skin')).toBe('night');
  });
});
