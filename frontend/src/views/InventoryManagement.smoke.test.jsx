import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

// Item Management render-smoke (Nov 2 2026, before the items split): each
// surface renders with items and checkouts in several states, and the key
// text (headings, buttons, tabs, column headers, labels) is pinned so moving
// code between files cannot silently drop a piece of the screen.

const NOW = new Date('2026-11-02T15:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();

const { role } = vi.hoisted(() => ({ role: { manager: false } }));

const ITEMS = [
  { id: 'i1', name: 'Dell Laptop', itemType: 'Computer', ownershipType: 'transient', status: 'available', location: 'HQ', department: 'IT', make: 'Dell', model: 'XPS 13', assetValue: 1200 },
  { id: 'i2', name: 'Ford Truck', itemType: 'Vehicles', ownershipType: 'transient', status: 'checked_out', location: 'Yard', department: 'Construction', make: 'Ford', model: 'F-150', assetValue: 40000 },
  { id: 'i3', name: 'iPhone 15', itemType: 'Devices', ownershipType: 'permanent', status: 'permanently_assigned', assignedToEmail: 'erin@greensglobal.com', assignedToName: 'Erin Test', location: 'HQ', department: 'IT', assetValue: 900 },
  { id: 'i4', name: 'Projector', itemType: 'Equipment', ownershipType: 'permanent', status: 'available', location: 'HQ', department: 'Operations', assetValue: 300 },
  { id: 'i5', name: 'Step Ladder', itemType: 'Tools', ownershipType: 'transient', status: 'available', location: 'Yard', department: 'Facilities', pictureRequired: false, assetValue: 80 },
];

const co = (o) => ({ requestedBy: 'Erin Test', requestedByEmail: 'erin@greensglobal.com', department: 'IT', days: 3, reason: 'Site visit', createdAt: day(-2), ...o });
const CHECKOUTS = [
  co({ id: 'c1', itemId: 'i5', itemName: 'Step Ladder', itemType: 'Tools', status: 'pending', orderId: 'o1', approverEmail: 'mia@greensglobal.com', approverName: 'Mia Boss' }),
  co({ id: 'c2', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'approved', orderId: 'o2', approvedBy: 'Mia Boss' }),
  co({ id: 'c3', itemId: 'i2', itemName: 'Ford Truck', itemType: 'Vehicles', status: 'allocated', allocatedAt: day(-10), createdAt: day(-11) }),
  co({ id: 'c4', itemId: 'i4', itemName: 'Projector', itemType: 'Equipment', status: 'pending_receipt', handedOverAt: day(-1) }),
  co({ id: 'c5', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'returned', allocatedAt: day(-30), returnedAt: day(-25), createdAt: day(-31) }),
  co({ id: 'c6', itemId: 'i5', itemName: 'Step Ladder', itemType: 'Tools', status: 'rejected', rejectionReason: 'Not available', createdAt: day(-5) }),
  co({ id: 'c7', itemId: 'i2', itemName: 'Ford Truck', itemType: 'Vehicles', status: 'allocated', requestedBy: 'Bob Field', requestedByEmail: 'bob@greensglobal.com', allocatedAt: day(-8), createdAt: day(-9), days: 2 }),
  co({ id: 'c8', itemId: 'i1', itemName: 'Dell Laptop', itemType: 'Computer', status: 'pending', requestedBy: 'Bob Field', requestedByEmail: 'bob@greensglobal.com', orderId: 'o3' }),
];

const ASSIGNMENTS = [
  { id: 'a1', itemId: 'i3', itemName: 'iPhone 15', assigneeEmail: 'erin@greensglobal.com', assigneeName: 'Erin Test', status: 'pending_acceptance', assignedBy: 'Mia Boss', createdAt: day(-1) },
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

const AUDIT = [
  { id: 'l1', action: 'Item Added', resource_id: 'i1', user_email: 'mia@greensglobal.com', timestamp: day(-3), details: JSON.stringify({ name: 'Dell Laptop', item_type: 'Computer', location: 'HQ' }) },
  { id: 'l2', action: 'Item Updated', resource_id: 'i2', user_email: 'mia@greensglobal.com', timestamp: day(-1), details: JSON.stringify({ name: 'Ford Truck', location: 'Yard' }) },
];
const apiData = {
  getAssignments: async () => ASSIGNMENTS,
  getItemCart: async () => [],
  getItemTypes: async () => [],
  getItemCustomFields: async () => [],
  getItemsAuditLog: async () => ({ rows: AUDIT }),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => apiData[k] || vi.fn(async () => []) });
  return { api, default: api };
});

const mod = await import('./InventoryManagement');
const InventoryManagement = mod.default;
const { EmployeeView, AddItemModal } = mod;
const { MyCheckoutsPanel } = await import('../inventory/checkout/MyCheckoutsPanel');
const { ManagerCheckoutsTab } = await import('../inventory/checkout/ManagerCheckoutsTab');

// Visible key text: headings, buttons, tabs, column headers and labels, in
// document order, whitespace collapsed.
function keyText(root = document.body) {
  return [...root.querySelectorAll('h1,h2,h3,h4,h5,button,[role="button"],[role="tab"],th,label')]
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const body = () => (document.body.textContent || '').replace(/\s+/g, ' ');
// How often each fixture name and status word shows up anywhere on the page,
// so a dropped row, card or label changes the snapshot too.
const PROBES = ['Dell Laptop', 'Ford Truck', 'iPhone 15', 'Projector', 'Step Ladder', 'Erin Test', 'Bob Field', 'Mia Boss',
  'HQ', 'Yard', 'Available', 'Checked out', 'Pending', 'Approved', 'Awaiting', 'Allocated', 'Returned', 'Rejected', 'Overdue', 'Due', 'Assigned'];
function probe() {
  const t = body();
  const out = {};
  for (const p of PROBES) { const n = t.split(p).length - 1; if (n) out[p] = n; }
  return out;
}
const shot = () => ({ keys: keyText(), seen: probe() });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); role.manager = false; });

const noop = () => {};
const resolved = () => Promise.resolve();

describe('Item Management smoke - employee', () => {
  it('home screen renders for an employee', async () => {
    render(<InventoryManagement activeSub={null} />);
    expect(await screen.findByText('Check Out an Item')).toBeTruthy();
    await waitFor(() => expect(body()).toContain('waiting for your acceptance'));
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Item Management",
          "Check Out an ItemBrowse available equipment and raise a checkout request.",
          "Return or Extend4 active4 items currently checked out.",
        ],
        "seen": {},
      }
    `);
  });

  it('catalog deep link shows the temporary items', async () => {
    render(<InventoryManagement activeSub="catalog" />);
    await screen.findAllByText('Dell Laptop');
    expect(body()).toContain('Step Ladder');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Back to Home",
          "Cart",
          "Browse Catalog",
          "My Checkouts4",
          "All",
          "Computer",
          "Peripheral",
          "Networking",
          "Server",
          "Storage",
          "IP Camera",
          "Devices",
          "Tools",
          "Equipment",
          "Vehicles",
          "Furniture",
          "Keys",
          "Other",
          "Tile",
          "List",
          "All",
          "HQ",
          "Yard",
        ],
        "seen": {
          "Checked out": 1,
          "Dell Laptop": 1,
          "Erin Test": 1,
          "Ford Truck": 1,
          "HQ": 2,
          "Pending": 2,
          "Step Ladder": 1,
          "Yard": 3,
        },
      }
    `);
  });

  it('My Checkouts deep link shows active checkouts in every state', async () => {
    render(<InventoryManagement activeSub="active-checkouts" />);
    await screen.findAllByText('Ford Truck');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Back to Home",
          "Cart",
          "Browse Catalog",
          "My Checkouts4",
          "Active Checkouts4",
          "Past Checkouts2",
          "Permanent1",
          "Cancel",
          "Cancel",
          "Extend Item",
          "Return Item",
          "Confirm receipt & upload photo",
        ],
        "seen": {
          "Approved": 3,
          "Awaiting": 1,
          "Dell Laptop": 1,
          "Due": 1,
          "Ford Truck": 1,
          "Overdue": 1,
          "Pending": 1,
          "Projector": 1,
          "Returned": 3,
          "Step Ladder": 1,
        },
      }
    `);
  });
});

describe('Item Management smoke - Manage mode', () => {
  beforeEach(() => { role.manager = true; });

  it('Manage list', async () => {
    render(<InventoryManagement activeSub="manage" />);
    await screen.findAllByText('Projector');
    expect(body()).toContain('Exit Manage');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "Available to check out2",
          "Unassigned permanent0",
          "Assigned · location1",
          "Assigned · person1",
          "Checked out1",
          "Total Items5",
          "Items Value$42,480",
          "Add Item",
          "Import CSV",
          "Export",
          "Manage",
          "Item",
          "Serial",
          "Type",
          "Dept",
          "Location",
          "Status",
          "Dell Laptop",
          "Ford Truck",
          "iPhone 15",
          "Projector",
          "Step Ladder",
        ],
        "seen": {
          "Assigned": 4,
          "Available": 3,
          "Checked out": 2,
          "Dell Laptop": 1,
          "Ford Truck": 1,
          "HQ": 5,
          "Projector": 1,
          "Step Ladder": 1,
          "Yard": 3,
          "iPhone 15": 1,
        },
      }
    `);
  });

  it('Catalog tab', async () => {
    render(<InventoryManagement activeSub="catalog" />);
    await screen.findAllByText('Dell Laptop');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "Tile",
          "List",
          "Photo",
          "Name",
          "Type",
          "Make",
          "Model",
          "Location",
          "Status",
        ],
        "seen": {
          "Dell Laptop": 1,
          "Erin Test": 2,
          "Ford Truck": 1,
          "HQ": 2,
          "Step Ladder": 1,
          "Yard": 3,
        },
      }
    `);
  });

  it('My Items tab', async () => {
    render(<InventoryManagement activeSub="myitems" />);
    await screen.findAllByText('Ford Truck');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "Active Checkouts4",
          "Past Checkouts2",
          "Permanent1",
          "Cancel",
          "Accept & upload photo",
          "Cancel",
          "Extend Item",
          "Return Item",
          "Confirm receipt & upload photo",
        ],
        "seen": {
          "Approved": 3,
          "Awaiting": 1,
          "Dell Laptop": 1,
          "Due": 1,
          "Ford Truck": 1,
          "Overdue": 1,
          "Pending": 1,
          "Projector": 1,
          "Returned": 3,
          "Step Ladder": 1,
        },
      }
    `);
  });

  it('Checkouts tab', async () => {
    render(<InventoryManagement activeSub="checkouts" />);
    await screen.findAllByText('Bob Field');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "Checkouts (Temporary)",
          "Assignments (Permanent) · 1",
          "Active5",
          "Pending approval2",
          "Awaiting handover1",
          "Completed2",
          "Send Alert",
          "Reject",
          "Approve",
          "Reject",
          "Hand Over",
          "Reject",
          "Approve",
          "Force Return",
          "Force Return",
        ],
        "seen": {
          "Awaiting": 2,
          "Bob Field": 2,
          "Dell Laptop": 2,
          "Erin Test": 4,
          "Ford Truck": 2,
          "Overdue": 2,
          "Pending": 3,
          "Projector": 1,
          "Step Ladder": 1,
        },
      }
    `);
  });

  it('Who Has What tab', async () => {
    render(<InventoryManagement activeSub="whohasit" />);
    await screen.findAllByText(/Bob Field/);
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "By person",
          "By location",
        ],
        "seen": {
          "Awaiting": 1,
          "Bob Field": 1,
          "Dell Laptop": 1,
          "Erin Test": 1,
          "Ford Truck": 2,
          "Projector": 1,
          "iPhone 15": 1,
        },
      }
    `);
  });

  it('Activity Log tab', async () => {
    render(<InventoryManagement activeSub="audit" />);
    await screen.findAllByText(/Ford Truck/);
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "1 item assigned to you - waiting for your acceptance.Review →",
          "Exit Manage",
          "Item Management · Manage",
          "Cart",
          "From",
          "To",
          "Show details",
          "Open item →",
          "Show details",
          "Open item →",
        ],
        "seen": {
          "Dell Laptop": 1,
          "Ford Truck": 1,
        },
      }
    `);
  });
});

describe('Item Management smoke - pieces', () => {
  it('EmployeeView home', async () => {
    render(<EmployeeView items={ITEMS} checkouts={CHECKOUTS} activeSub={null} userName="Erin Test" userEmail="erin@greensglobal.com"
      itemsLoading={false} itemsError={null} onReturn={resolved} refreshItems={noop} refreshCheckouts={noop}
      submitCartCheckouts={resolved} cancelRequest={resolved} allocateItem={resolved} initiateHandover={resolved}
      confirmReceipt={resolved} toast={noop} showManage onEnterManage={noop} />);
    expect(await screen.findByText('Check Out an Item')).toBeTruthy();
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Item Management",
          "Check Out an ItemBrowse available equipment and raise a checkout request.",
          "Return or Extend4 active4 items currently checked out.",
          "Manage ItemsAdd, edit, assign, import, types and the activity log - the full management tools.",
        ],
        "seen": {},
      }
    `);
  });

  it('ManagerCheckoutsTab', async () => {
    render(<ManagerCheckoutsTab checkouts={CHECKOUTS} items={ITEMS} userName="Mia Boss" userEmail="mia@greensglobal.com"
      approveRequest={resolved} rejectRequest={resolved} allocateItem={resolved} initiateHandover={resolved}
      refreshCheckouts={noop} refreshItems={noop} toast={noop} onSendAlert={noop}
      assignments={ASSIGNMENTS} refreshAssignments={noop} prefilter={null} activeSub={null} />);
    await screen.findAllByText('Bob Field');
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Checkouts (Temporary)",
          "Assignments (Permanent) · 1",
          "Active5",
          "Pending approval2",
          "Awaiting handover1",
          "Completed2",
          "Send Alert",
          "Reject",
          "Approve",
          "Reject",
          "Approve",
        ],
        "seen": {
          "Awaiting": 2,
          "Bob Field": 2,
          "Dell Laptop": 2,
          "Erin Test": 4,
          "Ford Truck": 2,
          "Overdue": 2,
          "Pending": 3,
          "Projector": 1,
          "Step Ladder": 1,
        },
      }
    `);
  });

  it('MyCheckoutsPanel with an overdue checkout', async () => {
    render(<MyCheckoutsPanel checkouts={CHECKOUTS} userEmail="erin@greensglobal.com" userName="Erin Test"
      onReturn={noop} onCancel={resolved} onSelfAllocate={resolved} onEmployeeAccept={resolved} onConfirmReceipt={resolved}
      onReRequest={resolved} onBatchReRequest={resolved} onReturnAll={resolved} onRequestExtension={resolved}
      assignments={ASSIGNMENTS} refreshAssignments={noop} toast={noop} activeSub={null} />);
    await screen.findAllByText('Ford Truck');
    expect(body()).toMatch(/overdue/i);
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Active Checkouts4",
          "Past Checkouts2",
          "Permanent1",
          "Cancel",
          "Accept & upload photo",
          "Cancel",
          "Extend Item",
          "Return Item",
          "Confirm receipt & upload photo",
        ],
        "seen": {
          "Approved": 3,
          "Awaiting": 1,
          "Dell Laptop": 1,
          "Due": 1,
          "Ford Truck": 1,
          "Overdue": 1,
          "Pending": 1,
          "Projector": 1,
          "Returned": 3,
          "Step Ladder": 1,
        },
      }
    `);
  });

  it('AddItemModal open', () => {
    render(<AddItemModal onClose={noop} onSave={resolved} />);
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Add Item",
          "NAME *",
          "TYPE *",
          "OWNERSHIP",
          "MAKE",
          "MODEL",
          "YEAR",
          "DEPARTMENT *",
          "OWNER · defaults to the department",
          "LOCATION *",
          "ASSET VALUE ($)",
          "Require photos in workflows - handover, receipt and return photos are mandatory for this item. Untick for items like keys where photos add no value.",
          "PHOTO *",
          "Upload photo (required)",
          "Add without a photo for now - the item will show under Missing photos; add one later via Batch update photos or AI photo fill.",
          "Cancel",
          "Add Item",
        ],
        "seen": {},
      }
    `);
  });

  it('Manage > Add Item opens the modal', async () => {
    role.manager = true;
    render(<InventoryManagement activeSub="manage" />);
    await screen.findAllByText('Projector');
    const add = screen.getAllByRole('button').find((b) => /^\s*Add Item\s*$/.test(b.textContent || ''));
    expect(add).toBeTruthy();
    fireEvent.click(add);
    const dialog = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]') || document.querySelector('.modal-content');
      expect(d).toBeTruthy();
      return d;
    });
    expect(keyText(dialog)).toMatchInlineSnapshot(`
      [
        "Add Item",
        "NAME *",
        "TYPE *",
        "OWNERSHIP",
        "MAKE",
        "MODEL",
        "YEAR",
        "DEPARTMENT *",
        "OWNER · defaults to the department",
        "LOCATION *",
        "ASSET VALUE ($)",
        "Require photos in workflows - handover, receipt and return photos are mandatory for this item. Untick for items like keys where photos add no value.",
        "PHOTO *",
        "Upload photo (required)",
        "Add without a photo for now - the item will show under Missing photos; add one later via Batch update photos or AI photo fill.",
        "Cancel",
        "Add Item",
      ]
    `);
    expect(within(document.body).getAllByText(/Add/).length).toBeGreaterThan(0);
  });
});
