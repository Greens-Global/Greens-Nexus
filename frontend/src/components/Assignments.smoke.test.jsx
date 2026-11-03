import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// Permanent assignments render-smoke (Items redesign, Neil 11/02/2026): the
// manager queue with an assignment in every state - the one set of words
// (Awaiting Acceptance, Active, Return Started, Closed, Declined, Canceled),
// Cancel / Force Recover held on the row - and the sheets an assignee uses.
// (The old My Items > Permanent panel is gone: My Stuff lists assignments
// with the checkouts - inventory/mystuff/MyStuffTab.jsx.)

const NOW = new Date('2026-11-02T15:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
const ME = 'erin@greensglobal.com';

const a = (o) => ({ assigneeEmail: ME, assigneeName: 'Erin Test', assignedBy: 'Mia Boss', createdAt: day(-3), ...o });
const ASSIGNMENTS = [
  a({ id: 'a1', itemId: 'i1', itemName: 'iPhone 15', status: 'pending_acceptance' }),
  a({ id: 'a2', itemId: 'i2', itemName: 'Dell Laptop', status: 'active', acceptedAt: day(-2) }),
  a({ id: 'a3', itemId: 'i3', itemName: 'Ford Truck', status: 'return_initiated', returnReason: 'dead', returnPhotoUrl: 'https://x.test/r.jpg', acceptedAt: day(-20) }),
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

const { AssignmentsQueue, AssignItemModal, AssignmentReturnModal, AcceptReturnModal } = await import('./Assignments');

const labels = () => [...document.querySelectorAll('.nx-label')].map(l => l.textContent);

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Assignments smoke', () => {
  it('the queue speaks the one set of words and holds Cancel / Force Recover', () => {
    render(<AssignmentsQueue assignments={ASSIGNMENTS} userEmail={ME} refresh={() => {}} toast={() => {}} />);
    expect(labels()).toEqual(['Awaiting Acceptance', 'Active', 'Return Started', 'Return Started', 'Active']);
    expect(screen.getByText(/Reported Dead/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accept Return/ })).toBeTruthy();       // the dead one has its photo
    expect(screen.getByRole('button', { name: /^Accept$/ })).toBeTruthy();            // mine, awaiting me
    expect(screen.getByRole('button', { name: /Cancel the assignment of iPhone 15, press and hold/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Force recover .*, press and hold/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /History/ }));
    expect(labels()).toEqual(['Closed', 'Declined', 'Canceled']);
  });

  it('the assign sheet opens', () => {
    render(<AssignItemModal item={{ id: 'i9', name: 'Projector', ownershipType: 'permanent' }} userEmail={ME} onClose={() => {}} onDone={() => {}} toast={() => {}} />);
    const sheet = screen.getByRole('dialog', { name: 'Assign Projector' });
    expect(within(sheet).getByRole('button', { name: 'To a Person' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /^Assign$/ })).toBeDisabled();
  });

  it('a lost permanent item is reported with no photo', () => {
    render(<AssignmentReturnModal a={ASSIGNMENTS[1]} reason="lost" onClose={() => {}} onDone={() => {}} toast={() => {}} />);
    expect(screen.queryByText('Return Photo')).toBeNull();
    const send = screen.getByRole('button', { name: /Report Lost/ });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'Left at the site' } });
    expect(send).not.toBeDisabled();
  });

  it('retiring a returned item is held; back to stock is a click', () => {
    render(<AcceptReturnModal a={ASSIGNMENTS[2]} onClose={() => {}} onDone={() => {}} toast={() => {}} />);
    expect(screen.getByRole('button', { name: /Hold to Retire, press and hold/ })).toBeTruthy();   // dead: Retire is the default
    fireEvent.click(screen.getByLabelText(/Back to stock/));
    expect(screen.getByRole('button', { name: /Back to Stock/ })).toBeTruthy();
  });
});
