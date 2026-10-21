import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// Workday > Purchase Requests (Neil, Oct 22 2026: moved out of Item
// Management). Employees see their own requests and raise new ones;
// Item Management managers (the same canAccessModule rule as the old tab)
// also get Approvals with approve-and-pick-a-fulfiller, reject, ordered and
// Received - Add to Items, which still opens the inventory Add Item form.

const { ctx, inventory, role, api } = vi.hoisted(() => ({
  ctx: {},
  inventory: { items: [], addItemLocal: vi.fn(), refreshItems: vi.fn() },
  role: { manager: false },
  api: {
    getItemAllocators: vi.fn(async () => [{ email: 'sam@greensglobal.com', name: 'Sam Buyer' }]),
    createItem: vi.fn(async (d) => ({ id: 'item-9', ...d })),
  },
}));
vi.mock('../contexts/RequisitionContext', () => ({ useRequisitions: () => ctx }));
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => inventory }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ canAccessModule: (mod, tier, level) => mod === 'inventory' && tier === 'manager' && level === 'editor' && role.manager }),
}));
vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ accounts: [{ name: 'Erin Test', username: 'erin@greensglobal.com' }] }),
}));
vi.mock('../api', () => ({ api, default: api }));
vi.mock('../lib/queries', () => ({
  usePeopleDirectory: () => ({ data: [] }),
  useItemApprovers: () => ({ data: [{ email: 'mia@greensglobal.com', name: 'Mia Manager' }] }),
}));
vi.mock('../views/InventoryManagement', () => ({
  AddItemModal: ({ initial, onSave, onClose }) => (
    <div role="dialog" aria-label="Add Item">
      <span>Prefilled {initial.name} for {initial.department}</span>
      <button onClick={async () => { await onSave({ name: initial.name }, {}); onClose(); }}>Save Item</button>
    </div>
  ),
}));

import PurchaseRequests, { PurchaseRequestTile } from './PurchaseRequests';

const req = (over) => ({
  id: 'REQ-1', employeeName: 'Erin Test', employeeEmail: 'erin@greensglobal.com', employeeDept: 'IT',
  item: 'Monitor', quantity: 2, reason: 'Second screen\nReference: https://www.example.com/monitor',
  status: 'pending_manager', createdAt: '2026-10-20T10:00:00Z', history: [], ...over,
});

beforeEach(() => {
  role.manager = false;
  Object.assign(ctx, {
    requisitions: [],
    approveRequisition: vi.fn(async () => {}), rejectRequisition: vi.fn(async () => {}),
    markRequisitionOrdered: vi.fn(async () => {}), fulfillRequisition: vi.fn(async () => {}),
    submitRequisition: vi.fn(async () => {}), exportToCsv: vi.fn(),
  });
  api.createItem.mockClear();
});
afterEach(cleanup);

describe('Workday Purchase Requests - employee', () => {
  it('lists only my requests with their status, reason, reference and history', () => {
    ctx.requisitions = [
      req({ history: [{ action: 'Submitted', by: 'Erin Test', date: '2026-10-20T10:00:00Z' }] }),
      req({ id: 'REQ-2', item: 'Laptop', status: 'rejected', rejectionReason: 'Over budget' }),
      req({ id: 'REQ-3', item: 'Desk', employeeName: 'Someone Else', employeeEmail: 'else@greensglobal.com' }),
    ];
    render(<PurchaseRequests />);
    expect(screen.getByText('My Requests')).toBeTruthy();
    expect(screen.getByText('Monitor')).toBeTruthy();
    expect(screen.getByText('Laptop')).toBeTruthy();
    expect(screen.queryByText('Desk')).toBeNull();
    expect(screen.getByText('Pending Approval')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText(/Over budget/)).toBeTruthy();
    expect(screen.getAllByText(/View Reference - example.com/)).toHaveLength(2);
    // No approver controls for an employee.
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Approvals/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /History \(1\)/ }));
    expect(screen.getByText('Submitted')).toBeTruthy();
  });

  it('shows an empty state, and New Purchase Request opens the form in a popup', async () => {
    render(<PurchaseRequests />);
    expect(screen.getByText('No purchase requests yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Purchase Request/ }));
    const dialog = screen.getByRole('dialog', { name: 'New Purchase Request' });
    expect(within(dialog).getByLabelText(/WHAT DO YOU NEED/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/WHAT DO YOU NEED/), { target: { value: 'Webcam' } });
    fireEvent.change(within(dialog).getByLabelText(/REASON/), { target: { value: 'Video calls' } });
    fireEvent.change(within(dialog).getByLabelText(/WHO SHOULD APPROVE/), { target: { value: 'mia@greensglobal.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Submit Request/ }));
    await waitFor(() => expect(ctx.submitRequisition).toHaveBeenCalledWith(expect.objectContaining({
      item: 'Webcam', employeeName: 'Erin Test', approverEmail: 'mia@greensglobal.com', reason: 'Video calls',
    })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Purchase Request' })).toBeNull());
  });

  it('opens the form straight away for the purchase:new deep link', () => {
    render(<PurchaseRequests openNewKey={1} />);
    expect(screen.getByRole('dialog', { name: 'New Purchase Request' })).toBeTruthy();
  });

  it('gives the person picked to purchase it the fulfillment actions', () => {
    ctx.requisitions = [req({ id: 'REQ-7', item: 'Chair', employeeName: 'Dean', employeeEmail: 'dean@greensglobal.com',
      status: 'manager_approved', allocatorEmail: 'erin@greensglobal.com', allocatorName: 'Erin Test' })];
    render(<PurchaseRequests />);
    expect(screen.getByText(/Assigned to You to Purchase - 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Mark Ordered/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Received - Add to Items/ })).toBeTruthy();
  });
});

describe('Workday Purchase Requests - approver', () => {
  it('lands on Approvals and approves with who purchases and fulfills it', async () => {
    role.manager = true;
    ctx.requisitions = [req({ employeeName: 'Dean', employeeEmail: 'dean@greensglobal.com' })];
    render(<PurchaseRequests />);
    expect(screen.getByRole('tab', { name: /Approvals \(1\)/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    const pick = await screen.findByLabelText('Who should purchase & fulfill this?');
    await waitFor(() => expect(within(pick).getByText('Sam Buyer')).toBeTruthy());
    fireEvent.change(pick, { target: { value: 'sam@greensglobal.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Approval/ }));
    await waitFor(() => expect(ctx.approveRequisition).toHaveBeenCalledWith('REQ-1', 'Erin Test', { email: 'sam@greensglobal.com', name: 'Sam Buyer' }));
  });

  it('rejects with a reason', async () => {
    role.manager = true;
    ctx.requisitions = [req({ employeeName: 'Dean', employeeEmail: 'dean@greensglobal.com' })];
    render(<PurchaseRequests />);
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/ }));
    fireEvent.change(screen.getByPlaceholderText('Reason for rejection…'), { target: { value: 'Not needed' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Reject/ }));
    await waitFor(() => expect(ctx.rejectRequisition).toHaveBeenCalledWith('REQ-1', 'Erin Test', 'Not needed'));
  });

  it('Received - Add to Items opens the prefilled Add Item form and fulfills with the new item', async () => {
    role.manager = true;
    ctx.requisitions = [req({ status: 'ordered', employeeName: 'Dean', employeeEmail: 'dean@greensglobal.com' })];
    render(<PurchaseRequests />);
    fireEvent.click(screen.getByRole('button', { name: /Received - Add to Items/ }));
    expect(await screen.findByText('Prefilled Monitor for IT')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save Item' }));
    await waitFor(() => expect(ctx.fulfillRequisition).toHaveBeenCalledWith('REQ-1', 'Erin Test', { note: 'Added to Items: Monitor', itemId: 'item-9' }));
    expect(api.createItem).toHaveBeenCalledWith({ name: 'Monitor' });
    expect(inventory.addItemLocal).toHaveBeenCalled();
  });

  it('My Requests shows only the approver\'s own', () => {
    role.manager = true;
    ctx.requisitions = [req({ id: 'REQ-5', item: 'Desk', employeeName: 'Dean', employeeEmail: 'dean@greensglobal.com' }), req({ id: 'REQ-6', item: 'Mouse' })];
    render(<PurchaseRequests />);
    expect(screen.getByText('Desk')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'My Requests' }));
    expect(screen.queryByText('Desk')).toBeNull();
    expect(screen.getByText('Mouse')).toBeTruthy();
  });
});

describe('Workday Overview Purchase Request tile', () => {
  it('opens Purchase Requests and says what is waiting', () => {
    const onOpen = vi.fn();
    ctx.requisitions = [req({ status: 'manager_approved' })];
    render(<PurchaseRequestTile onOpen={onOpen} />);
    expect(screen.getByText('1 in progress')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Purchase Request/ }));
    expect(onOpen).toHaveBeenCalled();
    cleanup();
    role.manager = true;
    ctx.requisitions = [req({ employeeEmail: 'dean@greensglobal.com', employeeName: 'Dean' })];
    render(<PurchaseRequestTile onOpen={onOpen} />);
    expect(screen.getByText('1 to approve')).toBeTruthy();
  });
});
