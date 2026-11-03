import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Permanent assignments render-smoke (Nov 2 2026, before the items split):
// the employee panel and the manager queue with an assignment in every
// state, and the assign modal open. Key text is pinned so nothing drops.

const NOW = new Date('2026-11-02T15:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
const ME = 'erin@greensglobal.com';

const a = (o) => ({ assigneeEmail: ME, assigneeName: 'Erin Test', assignedBy: 'Mia Boss', createdAt: day(-3), ...o });
const ASSIGNMENTS = [
  a({ id: 'a1', itemId: 'i1', itemName: 'iPhone 15', status: 'pending_acceptance' }),
  a({ id: 'a2', itemId: 'i2', itemName: 'Dell Laptop', status: 'active', acceptedAt: day(-2) }),
  a({ id: 'a3', itemId: 'i3', itemName: 'Ford Truck', status: 'return_initiated', returnReason: 'dead', acceptedAt: day(-20) }),
  a({ id: 'a4', itemId: 'i4', itemName: 'Badge Printer', status: 'return_initiated', returnReason: 'reassign', nextAssigneeEmail: 'bob@greensglobal.com', nextAssigneeName: 'Bob Field' }),
  a({ id: 'a5', itemId: 'i5', itemName: 'Old Monitor', status: 'closed', acceptedAt: day(-60) }),
  a({ id: 'a6', itemId: 'i6', itemName: 'Spare Keyboard', status: 'declined' }),
  a({ id: 'a7', itemId: 'i7', itemName: 'Tablet', status: 'cancelled' }),
  a({ id: 'a8', itemId: 'i8', itemName: 'Drill', status: 'active', assigneeEmail: 'bob@greensglobal.com', assigneeName: 'Bob Field' }),
];

vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: ME, name: 'Erin Test' }] }) }));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => (k === 'getAssignments' ? async () => ASSIGNMENTS : vi.fn(async () => [])) });
  return { api, default: api };
});
vi.mock('./PersonHoverCard', () => ({ default: ({ children }) => children }));

const { MyPermanentPanel, AssignmentsQueue, AssignItemModal } = await import('./Assignments');

function keyText(root = document.body) {
  return [...root.querySelectorAll('h1,h2,h3,h4,h5,button,[role="button"],[role="tab"],th,label')]
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const PROBES = ['iPhone 15', 'Dell Laptop', 'Ford Truck', 'Badge Printer', 'Old Monitor', 'Spare Keyboard', 'Tablet', 'Drill',
  'Erin Test', 'Bob Field', 'Awaiting acceptance', 'Assigned', 'Return in progress', 'Closed', 'Declined', 'Cancelled',
  'ITEM DEAD', 'ITEM LOST', 'REASSIGNMENT'];
function probe() {
  const t = (document.body.textContent || '').replace(/\s+/g, ' ');
  const out = {};
  for (const p of PROBES) { const n = t.split(p).length - 1; if (n) out[p] = n; }
  return out;
}
const shot = () => ({ keys: keyText(), seen: probe() });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Assignments smoke', () => {
  it('MyPermanentPanel shows every state of my assignments', () => {
    render(<MyPermanentPanel assignments={ASSIGNMENTS} userEmail={ME} refresh={() => {}} toast={() => {}} />);
    expect(screen.getByText('iPhone 15')).toBeTruthy();
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Decline",
          "Accept",
          "Report Dead",
          "Report Lost",
          "Return Item",
          "Return With Photo",
        ],
        "seen": {
          "Assigned": 8,
          "Awaiting acceptance": 1,
          "Badge Printer": 1,
          "Bob Field": 1,
          "Cancelled": 1,
          "Closed": 1,
          "Declined": 1,
          "Dell Laptop": 1,
          "Ford Truck": 1,
          "ITEM DEAD": 1,
          "Old Monitor": 1,
          "REASSIGNMENT": 1,
          "Return in progress": 2,
          "Spare Keyboard": 1,
          "Tablet": 1,
          "iPhone 15": 1,
        },
      }
    `);
  });

  it('MyPermanentPanel empty', () => {
    render(<MyPermanentPanel assignments={[]} userEmail={ME} refresh={() => {}} toast={() => {}} />);
    expect(screen.getByText('No items are permanently assigned to you.')).toBeTruthy();
  });

  it('AssignmentsQueue, every chip', () => {
    render(<AssignmentsQueue assignments={ASSIGNMENTS} userEmail={ME} refresh={() => {}} toast={() => {}} />);
    const shots = { live: shot() };
    for (const [key, label] of [['returns', 'Returns to accept'], ['pending', 'Awaiting acceptance'], ['history', 'History']]) {
      fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === label));
      shots[key] = shot();
    }
    expect(shots).toMatchInlineSnapshot(`
      {
        "history": {
          "keys": [
            "Live (5)",
            "Returns to accept",
            "Awaiting acceptance",
            "History",
          ],
          "seen": {
            "Awaiting acceptance": 1,
            "Cancelled": 1,
            "Closed": 1,
            "Declined": 1,
            "Erin Test": 3,
            "Old Monitor": 1,
            "Spare Keyboard": 1,
            "Tablet": 1,
          },
        },
        "live": {
          "keys": [
            "Live (5)",
            "Returns to accept",
            "Awaiting acceptance",
            "History",
            "Accept & upload photo",
            "Cancel",
            "Force recover",
            "Force recover",
            "Force recover",
            "Force recover",
          ],
          "seen": {
            "Assigned": 2,
            "Awaiting acceptance": 2,
            "Badge Printer": 1,
            "Bob Field": 2,
            "Dell Laptop": 1,
            "Drill": 1,
            "Erin Test": 4,
            "Ford Truck": 1,
            "ITEM DEAD": 1,
            "REASSIGNMENT": 1,
            "Return in progress": 2,
            "iPhone 15": 1,
          },
        },
        "pending": {
          "keys": [
            "Live (5)",
            "Returns to accept",
            "Awaiting acceptance",
            "History",
            "Accept & upload photo",
            "Cancel",
          ],
          "seen": {
            "Awaiting acceptance": 2,
            "Erin Test": 1,
            "iPhone 15": 1,
          },
        },
        "returns": {
          "keys": [
            "Live (5)",
            "Returns to accept",
            "Awaiting acceptance",
            "History",
            "Force recover",
            "Force recover",
          ],
          "seen": {
            "Awaiting acceptance": 1,
            "Badge Printer": 1,
            "Bob Field": 1,
            "Erin Test": 2,
            "Ford Truck": 1,
            "ITEM DEAD": 1,
            "REASSIGNMENT": 1,
            "Return in progress": 2,
          },
        },
      }
    `);
  });

  it('AssignItemModal open', () => {
    render(<AssignItemModal item={{ id: 'i9', name: 'Laptop', ownershipType: 'permanent' }} mode="assign" userEmail={ME}
      locations={['HQ', 'Yard']} onClose={() => {}} onDone={() => {}} toast={() => {}} />);
    expect(shot()).toMatchInlineSnapshot(`
      {
        "keys": [
          "Assign Laptop",
          "To a person",
          "To a location",
          "ASSIGN TO *",
          "Select a person",
          "Skip acceptance - the assignment goes active right away. They're still notified, just not asked to accept.",
          "Cancel",
          "Assign",
        ],
        "seen": {},
      }
    `);
  });
});
