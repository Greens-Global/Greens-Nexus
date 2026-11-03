import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';

// Item Management render-smoke (Items redesign, Neil 11/02/2026). Pins the
// NEW shape deliberately: role-based tabs (My Stuff, Borrow, Requests,
// Inventory) instead of the chooser home and Manage mode, the urgency groups,
// the one set of words, the borrowable-only catalog, the Requests queues, the
// Inventory views and the item record - and that every old sub still lands.

const NOW = new Date('2026-11-02T15:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
const ymd = (n) => day(n).slice(0, 10);

const { role } = vi.hoisted(() => ({ role: { manager: false } }));

const ITEMS = [
  { id: 'i1', name: 'Dell Laptop', itemType: 'Computer', ownershipType: 'transient', status: 'available', hasActiveRequest: true, location: 'HQ', department: 'IT', make: 'Dell', model: 'XPS 13', assetValue: 1200 },
  { id: 'i2', name: 'Ford Truck', itemType: 'Vehicles', ownershipType: 'transient', status: 'checked_out', location: 'Yard', department: 'Construction', make: 'Ford', model: 'F-150', assetValue: 40000, serialNumber: 'GG-00002' },
  { id: 'i3', name: 'iPhone 15', itemType: 'Devices', ownershipType: 'permanent', status: 'available', location: 'HQ', department: 'IT', assetValue: 900 },
  { id: 'i4', name: 'Projector', itemType: 'Equipment', ownershipType: 'transient', status: 'checked_out', location: 'HQ', department: 'Operations', assetValue: 300 },
  { id: 'i5', name: 'Step Ladder', itemType: 'Tools', ownershipType: 'transient', status: 'available', hasActiveRequest: true, location: 'Yard', department: 'Facilities', pictureRequired: false, assetValue: 80 },
  { id: 'i6', name: 'Pressure Washer', itemType: 'Equipment', ownershipType: 'transient', status: 'available', location: 'Yard', department: 'Facilities', assetValue: 650 },
];

const co = (o) => ({ requestedBy: 'Erin Test', requestedByEmail: 'erin@greensglobal.com', department: 'IT', days: 3, reason: 'Site visit', createdAt: day(-2), ...o });
const CHECKOUTS = [
  co({ id: 'c1', itemId: 'i5', itemName: 'Step Ladder', itemType: 'Tools', status: 'pending', orderId: 'o1', approverName: 'Mia Boss', requestedDueDate: ymd(5) }),
  co({ id: 'c2', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'approved', orderId: 'o2', assignedAllocatorName: 'Alan Hand', assignedAllocatorEmail: 'alan@greensglobal.com' }),
  co({ id: 'c3', itemId: 'i2', itemName: 'Ford Truck', itemType: 'Vehicles', status: 'allocated', handedOverAt: day(-10), allocatedAt: day(-10), createdAt: day(-11), dueAt: day(-7), dueDate: ymd(-7), checkoutPhotoUrl: 'https://x.test/hand.jpg' }),
  co({ id: 'c4', itemId: 'i4', itemName: 'Projector', itemType: 'Equipment', status: 'pending_receipt', handedOverAt: day(-1), allocatedBy: 'Alan Hand' }),
  co({ id: 'c5', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'returned', handedOverAt: day(-30), allocatedAt: day(-30), returnedAt: day(-25), createdAt: day(-31) }),
  co({ id: 'c8', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'pending', requestedBy: 'Bob Field', requestedByEmail: 'bob@greensglobal.com', orderId: 'o3', requestedDueDate: ymd(4) }),
];
const ASSIGNMENTS = [
  { id: 'a1', itemId: 'i3', itemName: 'iPhone 15', assigneeEmail: 'erin@greensglobal.com', assigneeName: 'Erin Test', status: 'pending_acceptance', assignedBy: 'Mia Boss', createdAt: day(-1) },
  { id: 'a2', itemId: 'i7', itemName: 'Badge Printer', assigneeEmail: 'erin@greensglobal.com', assigneeName: 'Erin Test', status: 'active', assignedBy: 'Mia Boss', createdAt: day(-20), acceptedAt: day(-19) },
  { id: 'a3', itemId: 'i8', itemName: 'Old Monitor', assigneeEmail: 'erin@greensglobal.com', assigneeName: 'Erin Test', status: 'return_initiated', returnReason: 'normal', returnPhotoUrl: 'https://x.test/r.jpg', assignedBy: 'Mia Boss', createdAt: day(-40) },
];

const inv = {
  items: ITEMS, itemsLoading: false, itemsError: null,
  checkouts: CHECKOUTS, checkoutsLoading: false, checkoutsError: null,
  submitCartCheckouts: vi.fn(), approveRequest: vi.fn(), rejectRequest: vi.fn(),
  allocateItem: vi.fn(), initiateHandover: vi.fn(), confirmReceipt: vi.fn(), returnItem: vi.fn(), cancelRequest: vi.fn(),
  refreshItems: vi.fn(), refreshCheckouts: vi.fn(),
  patchItemLocal: vi.fn(), removeItemsLocal: vi.fn(), addItemLocal: vi.fn(),
};
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => inv }));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ addNotification: vi.fn(), notifications: [] }) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: () => role.manager, canAccessModule: () => role.manager, loading: false,
    myGrantedModules: new Map(), myEmail: 'erin@greensglobal.com',
  }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Erin Test', username: 'erin@greensglobal.com' }] }),
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }), useItemApprovers: () => ({ data: [] }) }));
const apiData = {
  getAssignments: async () => ASSIGNMENTS,
  getItemCart: async () => [],
  getItemTypes: async () => [],
  getItemCustomFields: async () => [],
  getItemTypeSettings: async () => [{ name: 'Devices', borrowable: false }, { name: 'Equipment', borrowable: true }],
  getItemsAuditLog: async () => ({ rows: [], total: 0 }),
  getTicketAiStatus: async () => ({ keyConfigured: false }),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => apiData[k] || vi.fn(async () => []) });
  return { api, default: api };
});

const mod = await import('./InventoryManagement');
const InventoryManagement = mod.default;
const { AddItemModal } = mod;
const { HeaderTabsProvider, useHeaderTabs } = await import('../components/ModuleTabs');

function HeaderTabs() {
  const entry = useHeaderTabs();
  return <div data-testid="header-tabs">{(entry?.tabs || []).map((t) => t.label).join('|')}</div>;
}
const renderAt = (sub, onSubChange = vi.fn()) => {
  render(<HeaderTabsProvider><HeaderTabs /><InventoryManagement activeSub={sub} onSubChange={onSubChange} /></HeaderTabsProvider>);
  return onSubChange;
};
// The tabs live in the page (never behind the header search) - read them there.
const tabs = () => [...document.querySelectorAll('.it-tabs .module-tab-inline-btn')].map(b => b.childNodes[1]?.textContent?.trim() || b.textContent.trim()).join('|');
const body = () => (document.body.textContent || '').replace(/\s+/g, ' ');

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); role.manager = false; });

describe('Item Management smoke - everyone', () => {
  it('lands on My Stuff, most urgent first, with only My Stuff and Borrow', async () => {
    renderAt(null);
    await screen.findByRole('heading', { name: 'My Stuff' });
    await waitFor(() => expect(tabs()).toBe('My Stuff|Borrow'));
    await screen.findByText('iPhone 15');
    const groups = [...document.querySelectorAll('.it-group-h')].map(h => h.firstChild.textContent);
    expect(groups).toEqual(['Overdue', 'Your Action Needed', 'Waiting on Others', 'In Use', 'History']);
    // The one set of words: Overdue replaces In Use; Handed Over; Requested; Approved.
    const overdue = screen.getByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByText('Ford Truck')).toBeTruthy();
    expect(overdue.querySelector('.nx-label')?.textContent).toBe('Overdue');
    expect(within(overdue).queryByText('In Use')).toBeNull();
    expect(body()).toContain('Handed Over');
    expect(body()).toContain('Awaiting Acceptance');
    expect(screen.getByRole('button', { name: /Confirm Receipt/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Start Return/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Accept$/ })).toBeTruthy();
    // Return dates read MM/DD/YYYY.
    expect(body()).toMatch(/Return by \d{2}\/\d{2}\/\d{4}/);
    // Bob's request is his, not mine.
    expect(body()).not.toContain('Bob Field');
  });

  it('Borrow lists only borrowable temporary items, unavailable ones after', async () => {
    renderAt('borrow');
    await screen.findByText('Pressure Washer');
    expect(body()).not.toContain('iPhone 15');          // permanent (and Devices is not borrowable)
    const names = [...document.querySelectorAll('.it-tile-name')].map(n => n.textContent);
    expect(names[0]).toBe('Pressure Washer');           // free first
    expect(names).toEqual(expect.arrayContaining(['Ford Truck', 'Dell Laptop', 'Step Ladder', 'Projector']));
    expect(screen.getByRole('button', { name: /Add/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeTruthy();
    expect(body()).not.toContain('Missing photo');       // no red boxes before anyone acts
  });

  it('old subs land on the new tabs without pushing a second address', async () => {
    // The address itself is mapped (and REPLACED) in lib/routes.js itemsRedirect;
    // the screen never rewrites it, so Back leaves Items instead of looping.
    const onSub = renderAt('catalog');
    await screen.findByRole('heading', { name: 'Borrow' });
    expect(onSub).not.toHaveBeenCalled();
    cleanup();
    renderAt('active-checkouts');
    await screen.findByRole('heading', { name: 'My Stuff' });
    cleanup();
    // An employee sent to a manager queue lands on what they can open.
    renderAt('checkouts');
    await screen.findByRole('heading', { name: 'My Stuff' });
  });

  it('the item record opens over a tab from the address', async () => {
    renderAt('mystuff@i2');
    const dialog = await screen.findByRole('dialog', { name: 'Ford Truck' });
    expect(within(dialog).getByText(/With Erin Test since \d{2}\/\d{2}\/\d{4}/)).toBeTruthy();
    expect(within(dialog).getByRole('progressbar', { name: 'Loan' })).toBeTruthy();
    expect(within(dialog).getByText(/Handed over to Erin Test/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Start Return/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Extend/ })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Timeline' })).toBeTruthy();
  });
});

describe('Item Management review fixes (11/02/2026)', () => {
  it('the phone bottom bar survives moves inside Items (go is stable)', async () => {
    const { rerender } = render(<InventoryManagement activeSub="mystuff" onSubChange={vi.fn()} />);
    await screen.findByRole('heading', { name: 'My Stuff' });
    rerender(<InventoryManagement activeSub="borrow" onSubChange={vi.fn()} />);   // a new closure, as App renders
    await screen.findByRole('heading', { name: 'Borrow' });
    expect(window.__nexusMobileActions?.map(a => `${a.label}${a.active ? '*' : ''}`)).toEqual(['My Stuff', 'Borrow*']);
    cleanup();
    expect(window.__nexusMobileActions).toBeNull();                                // gone only when Items leaves
  });

  it('Report Dead / Report Lost are back for an item assigned to you; Lost needs no photo', async () => {
    renderAt('mystuff');
    fireEvent.click(await screen.findByRole('button', { name: 'More for Badge Printer' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Report Lost' }));
    const sheet = await screen.findByRole('dialog', { name: /Report Lost: Badge Printer/ });
    expect(within(sheet).queryByText('Return Photo')).toBeNull();
  });
});

describe('Item Management smoke - managers', () => {
  beforeEach(() => { role.manager = true; });

  it('managers get all four tabs and no Purchase Requests', async () => {
    renderAt('mystuff');
    await waitFor(() => expect(tabs()).toBe('My Stuff|Borrow|Requests|Inventory'));
    expect(screen.queryByText('Purchase Requests')).toBeNull();
    // A manager's own approved request is theirs to take (My Stuff).
  });

  it('Requests shows the queues and never an Approve on your own request', async () => {
    renderAt('requests:approve');
    await screen.findByText('Bob Field');
    const chips = [...document.querySelectorAll('.it-chip')].map(c => c.firstChild.textContent);
    expect(chips).toEqual(['To Approve', 'To Hand Over', 'Returns', 'Overdue', 'In Use', 'Assignments', 'Done']);
    expect(screen.getAllByRole('button', { name: /^Approve$/ })).toHaveLength(1);   // Bob's only
    expect(screen.getByText('Your request')).toBeTruthy();                          // Erin's own Step Ladder
  });

  it('never Force Return on your own checkout, never Accept Return on your own return', async () => {
    renderAt('requests:overdue');
    await screen.findAllByText('Ford Truck');                        // Erin's own, overdue
    expect(screen.queryByRole('button', { name: /Force Return/ })).toBeNull();
    cleanup();
    renderAt('requests:returns');
    await screen.findByText('Old Monitor');
    expect(screen.getByText('Your return')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept Return/ })).toBeNull();
    // Queue chips are toggle buttons (no tab without a panel).
    expect(screen.getByRole('button', { name: /Returns/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the handover queue hands over with the brand button', async () => {
    renderAt('handover');
    const btn = (await screen.findAllByRole('button', { name: /^Hand Over$/ }))[0];
    expect(btn.className).toContain('primary-btn');
    expect(btn.getAttribute('style') || '').not.toContain('orange');
  });

  it('Inventory has four tiles and its three views', async () => {
    renderAt('manage');
    await screen.findByText('Available to Borrow');
    expect([...document.querySelectorAll('.it-kpi-label')].map(k => k.textContent)).toEqual(['Available to Borrow', 'In Use', 'Overdue', 'Total Value']);
    expect(screen.getAllByRole('tab').map(t => t.textContent.trim())).toEqual(expect.arrayContaining(['Table', 'Who Has What', 'Activity']));
    expect(screen.getByRole('button', { name: /Add Item/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import CSV/ })).toBeTruthy();
  });

  it('Who Has What and the Activity Log are views inside Inventory', async () => {
    renderAt('whohasit');
    await screen.findByRole('tab', { name: /Who Has What/, selected: true });
    cleanup();
    renderAt('audit');
    await screen.findByRole('tab', { name: /Activity/, selected: true });
  });
});

describe('Item Management smoke - Add Item', () => {
  it('has a Serial field and Save and Add Another', () => {
    render(<AddItemModal onClose={() => {}} onSave={() => Promise.resolve()} allowAddAnother />);
    expect(screen.getByLabelText(/Serial/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save and Add Another' })).toBeTruthy();
    expect(screen.queryByText(/Find a product photo/i)).toBeNull();   // AI is off
  });
});
